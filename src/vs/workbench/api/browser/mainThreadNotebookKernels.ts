/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { flatten } from 'vs/base/common/arrays';
import { Emitter, Event } from 'vs/base/common/event';
import { combinedDisposable, DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { extHostNamedCustomer } from 'vs/workbench/api/common/extHostCustomers';
import { INotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { INotebookEditorService } from 'vs/workbench/contrib/notebook/browser/notebookEditorService';
import { ICellRange } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { INotebookKernel2, INotebookKernel2ChangeEvent, INotebookKernelService } from 'vs/workbench/contrib/notebook/common/notebookKernelService';
import { NotebookSelector } from 'vs/workbench/contrib/notebook/common/notebookSelector';
import { ExtHostContext, ExtHostNotebookKernelsShape, IExtHostContext, INotebookKernelDto2, MainContext, MainThreadNotebookKernelsShape } from '../common/extHost.protocol';

abstract class MainThreadKernel implements INotebookKernel2 {

	private readonly _onDidChange = new Emitter<INotebookKernel2ChangeEvent>();
	private readonly preloads: { uri: URI, provides: string[] }[];
	readonly onDidChange: Event<INotebookKernel2ChangeEvent> = this._onDidChange.event;

	readonly id: string;
	readonly selector: NotebookSelector;
	readonly extension: ExtensionIdentifier;

	implementsInterrupt: boolean;
	label: string;
	description?: string;
	detail?: string;
	isPreferred?: boolean;
	supportedLanguages: string[];
	implementsExecutionOrder: boolean;
	localResourceRoot: URI;

	public get preloadUris() {
		return this.preloads.map(p => p.uri);
	}

	public get preloadProvides() {
		return flatten(this.preloads.map(p => p.provides));
	}

	constructor(data: INotebookKernelDto2) {
		this.id = data.id;
		this.selector = data.selector;
		this.extension = data.extensionId;

		this.implementsInterrupt = data.supportsInterrupt ?? false;
		this.label = data.label;
		this.description = data.description;
		this.isPreferred = data.isPreferred;
		this.supportedLanguages = data.supportedLanguages;
		this.implementsExecutionOrder = data.hasExecutionOrder ?? false;
		this.localResourceRoot = URI.revive(data.extensionLocation);
		this.preloads = data.preloads?.map(u => ({ uri: URI.revive(u.uri), provides: u.provides })) ?? [];
	}


	update(data: Partial<INotebookKernelDto2>) {
		const event: INotebookKernel2ChangeEvent = Object.create(null);
		if (data.label !== undefined) {
			this.label = data.label;
			event.label = true;
		}
		if (data.description !== undefined) {
			this.description = data.description;
			event.description = true;
		}
		if (data.isPreferred !== undefined) {
			this.isPreferred = data.isPreferred;
			event.isPreferred = true;
		}
		if (data.supportedLanguages !== undefined) {
			this.supportedLanguages = data.supportedLanguages;
			event.supportedLanguages = true;
		}
		if (data.hasExecutionOrder !== undefined) {
			this.implementsExecutionOrder = data.hasExecutionOrder;
			event.hasExecutionOrder = true;
		}
		this._onDidChange.fire(event);
	}

	abstract executeNotebookCellsRequest(uri: URI, ranges: ICellRange[]): void;
	abstract cancelNotebookCellExecution(uri: URI, ranges: ICellRange[]): void;
}

@extHostNamedCustomer(MainContext.MainThreadNotebookKernels)
export class MainThreadNotebookKernels implements MainThreadNotebookKernelsShape {

	private readonly _editors = new Map<INotebookEditor, IDisposable>();
	private readonly _disposables = new DisposableStore();

	private readonly _kernels = new Map<number, [kernel: MainThreadKernel, registraion: IDisposable]>();
	private readonly _proxy: ExtHostNotebookKernelsShape;

	constructor(
		extHostContext: IExtHostContext,
		@INotebookKernelService private readonly _notebookKernelService: INotebookKernelService,
		@INotebookEditorService notebookEditorService: INotebookEditorService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostNotebookKernels);

		notebookEditorService.listNotebookEditors().forEach(this._onEditorAdd, this);
		notebookEditorService.onDidAddNotebookEditor(this._onEditorAdd, this, this._disposables);
		notebookEditorService.onDidRemoveNotebookEditor(this._onEditorRemove, this, this._disposables);
	}

	dispose(): void {
		this._disposables.dispose();
		for (let [, registration] of this._kernels.values()) {
			registration.dispose();
		}
	}

	// --- kernel ipc

	private _onEditorAdd(editor: INotebookEditor) {

		const ipcListener = editor.onDidReceiveMessage(e => {
			if (e.forRenderer) {
				return;
			}
			if (!editor.hasModel()) {
				return;
			}
			const kernel = this._notebookKernelService.getBoundKernel(editor.viewModel.notebookDocument);
			if (!kernel) {
				return;
			}
			for (let [handle, candidate] of this._kernels) {
				if (candidate[0] === kernel) {
					this._proxy.$acceptRendererMessage(handle, editor.getId(), e.message);
					break;
				}
			}
		});
		this._editors.set(editor, ipcListener);
	}

	private _onEditorRemove(editor: INotebookEditor) {
		this._editors.get(editor)?.dispose();
		this._editors.delete(editor);
	}

	async $postMessage(handle: number, editorId: string | undefined, message: any): Promise<boolean> {
		const tuple = this._kernels.get(handle);
		if (!tuple) {
			throw new Error('kernel already disposed');
		}
		const [kernel] = tuple;
		let didSend = false;
		for (const [editor] of this._editors) {
			if (!editor.hasModel()) {
				continue;
			}
			if (this._notebookKernelService.getBoundKernel(editor.viewModel.notebookDocument) !== kernel) {
				// different kernel
				continue;
			}
			if (editorId === undefined) {
				// all editors
				editor.postMessage(undefined, message);
				didSend = true;
			} else if (editor.getId() === editorId) {
				// selected editors
				editor.postMessage(undefined, message);
				didSend = true;
				break;
			}
		}
		return didSend;
	}

	// --- kernel adding/updating/removal

	async $addKernel(handle: number, data: INotebookKernelDto2): Promise<void> {
		const that = this;
		const kernel = new class extends MainThreadKernel {
			executeNotebookCellsRequest(uri: URI, ranges: ICellRange[]): void {
				that._proxy.$executeCells(handle, uri, ranges);
			}
			cancelNotebookCellExecution(uri: URI, ranges: ICellRange[]): void {
				that._proxy.$cancelCells(handle, uri, ranges);
			}
		}(data);
		const registration = this._notebookKernelService.registerKernel(kernel);

		const listener = this._notebookKernelService.onDidChangeNotebookKernelBinding(e => {
			if (e.oldKernel === kernel) {
				this._proxy.$acceptSelection(handle, e.notebook, false);
			} else if (e.newKernel === kernel) {
				this._proxy.$acceptSelection(handle, e.notebook, true);
			}
		});

		this._kernels.set(handle, [kernel, combinedDisposable(listener, registration)]);
	}

	$updateKernel(handle: number, data: Partial<INotebookKernelDto2>): void {
		const tuple = this._kernels.get(handle);
		if (tuple) {
			tuple[0].update(data);
		}
	}

	$removeKernel(handle: number): void {
		const tuple = this._kernels.get(handle);
		if (tuple) {
			tuple[1].dispose();
			this._kernels.delete(handle);
		}
	}
}
