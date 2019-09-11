/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { find } from 'vs/base/common/arrays';
import * as glob from 'vs/base/common/glob';
import { UnownedDisposable } from 'vs/base/common/lifecycle';
import { basename } from 'vs/base/common/resources';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import * as nls from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IEditor, IEditorInput } from 'vs/workbench/common/editor';
import { webviewEditorsExtensionPoint } from 'vs/workbench/contrib/customEditor/browser/extensionPoint';
import { CustomEditorDiscretion, CustomEditorInfo, CustomEditorSelector, ICustomEditorService } from 'vs/workbench/contrib/customEditor/common/customEditor';
import { FileEditorInput } from 'vs/workbench/contrib/files/common/editors/fileEditorInput';
import { IWebviewService } from 'vs/workbench/contrib/webview/browser/webview';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService, IOpenEditorOverride } from 'vs/workbench/services/editor/common/editorService';
import { CustomFileEditorInput } from './customEditorInput';

export class CustomEditorService implements ICustomEditorService {
	_serviceBrand: any;

	private readonly customEditors: Array<CustomEditorInfo> = [];

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		webviewEditorsExtensionPoint.setHandler(extensions => {
			for (const extension of extensions) {
				for (const webviewEditorContribution of extension.value) {
					this.customEditors.push({
						id: webviewEditorContribution.viewType,
						displayName: webviewEditorContribution.displayName,
						selector: webviewEditorContribution.selector || [],
						discretion: webviewEditorContribution.discretion || CustomEditorDiscretion.default,
					});
				}
			}
		});
	}

	public getCustomEditorsForResource(resource: URI): readonly CustomEditorInfo[] {
		return this.customEditors.filter(customEditor =>
			customEditor.selector.some(selector => matches(selector, resource)));
	}

	public async promptOpenWith(
		resource: URI,
		options?: ITextEditorOptions,
		group?: IEditorGroup,
	): Promise<IEditor | undefined> {
		const preferredEditors = await this.getCustomEditorsForResource(resource);
		const defaultEditorId = 'default';
		const pick = await this.quickInputService.pick([
			{
				label: nls.localize('promptOpenWith.defaultEditor', "Default built-in editor"),
				id: defaultEditorId,
			},
			...preferredEditors.map((editorDescriptor): IQuickPickItem => ({
				label: editorDescriptor.displayName,
				id: editorDescriptor.id,
			}))
		], {
			placeHolder: nls.localize('promptOpenWith.placeHolder', "Select editor to use for '{0}'...", basename(resource)),
		});

		if (!pick) {
			return;
		}

		if (pick.id === defaultEditorId) {
			const fileInput = this.instantiationService.createInstance(FileEditorInput, resource, undefined, undefined);
			return this.editorService.openEditor(fileInput, { ...options, ignoreOverrides: true }, group);
		} else {
			return this.openWith(resource, pick.id!, options, group);
		}
	}

	public openWith(
		resource: URI,
		viewType: string,
		options?: ITextEditorOptions,
		group?: IEditorGroup,
	): Promise<IEditor | undefined> {
		if (!this.customEditors.some(x => x.id === viewType)) {
			return this.promptOpenWith(resource, options, group);
		}

		const id = generateUuid();
		const webview = this.webviewService.createWebviewEditorOverlay(id, {}, {});
		const input = this.instantiationService.createInstance(CustomFileEditorInput, resource, viewType, id, new UnownedDisposable(webview));
		if (group) {
			input.updateGroup(group!.id);
		}
		return this.editorService.openEditor(input, options, group);
	}
}

export const customEditorsAssociationsKey = 'workbench.experimental.editorAssociations';

export type CustomEditorsAssociations = readonly (CustomEditorSelector & { readonly viewType: string })[];

export class CustomEditorContribution implements IWorkbenchContribution {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICustomEditorService private readonly customEditorService: ICustomEditorService,
	) {
		this.editorService.overrideOpenEditor((editor, options, group) => this.onEditorOpening(editor, options, group));
	}

	private getConfiguredCustomEditor(resource: URI): string | undefined {
		const config = this.configurationService.getValue<CustomEditorsAssociations>(customEditorsAssociationsKey) || [];
		const match = find(config, association => matches(association, resource));
		return match ? match.viewType : undefined;
	}

	private onEditorOpening(
		editor: IEditorInput,
		options: ITextEditorOptions | undefined,
		group: IEditorGroup
	): IOpenEditorOverride | undefined {
		if (editor instanceof CustomFileEditorInput) {
			return;
		}

		const resource = editor.getResource();
		if (!resource) {
			return;
		}

		const userConfiguredViewType = this.getConfiguredCustomEditor(resource);
		const customEditors = this.customEditorService.getCustomEditorsForResource(resource);

		if (!userConfiguredViewType) {
			if (!customEditors.length) {
				return;
			}

			const defaultEditors = customEditors.filter(editor => editor.discretion === CustomEditorDiscretion.default);
			if (defaultEditors.length === 1) {
				return {
					override: this.customEditorService.openWith(resource, defaultEditors[0].id, options, group),
				};
			}
		}

		for (const input of group.editors) {
			if (input instanceof CustomFileEditorInput && input.getResource().toString() === resource.toString()) {
				return {
					override: group.openEditor(input, options).then(withNullAsUndefined)
				};
			}
		}

		if (userConfiguredViewType) {
			return {
				override: this.customEditorService.openWith(resource, userConfiguredViewType, options, group),
			};
		}

		// Open default editor but prompt user to see if they wish to use a custom one instead
		return {
			override: (async () => {
				const standardEditor = await this.editorService.openEditor(editor, { ...options, ignoreOverrides: true }, group);
				const selectedEditor = await this.customEditorService.promptOpenWith(resource, options, group);
				if (selectedEditor && selectedEditor.input) {
					await group.replaceEditors([{
						editor,
						replacement: selectedEditor.input
					}]);
					return selectedEditor;
				}

				return standardEditor;
			})()
		};
	}
}

function matches(selector: CustomEditorSelector, resource: URI): boolean {
	if (!selector.filenamePattern && !selector.scheme) {
		return false;
	}
	if (selector.filenamePattern) {
		if (!glob.match(selector.filenamePattern.toLowerCase(), basename(resource).toLowerCase())) {
			return false;
		}
	}
	if (selector.scheme) {
		if (resource.scheme !== selector.scheme) {
			return false;
		}
	}
	return true;
}
