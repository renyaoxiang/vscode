/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { SimpleIconLabel } from 'vs/base/browser/ui/iconLabel/simpleIconLabel';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from 'vs/base/common/actions';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Emitter, Event } from 'vs/base/common/event';
import { stripIcons } from 'vs/base/common/iconLabels';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { ElementSizeObserver } from 'vs/editor/browser/config/elementSizeObserver';
import { IDimension } from 'vs/editor/common/editorCommon';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { INotebookCellActionContext } from 'vs/workbench/contrib/notebook/browser/contrib/coreActions';
import { CellStatusbarAlignment, INotebookCellStatusBarItem } from 'vs/workbench/contrib/notebook/common/notebookCommon';

const $ = DOM.$;

export interface IClickTarget {
	type: ClickTargetType;
	event: MouseEvent;
}

export const enum ClickTargetType {
	Container = 0,
	CellStatus = 1,
	ContributedTextItem = 2,
	ContributedCommandItem = 3
}

export class CellEditorStatusBar extends Disposable {
	readonly cellRunStatusContainer: HTMLElement;
	readonly statusBarContainer: HTMLElement;
	readonly durationContainer: HTMLElement;

	private readonly leftContributedItemsContainer: HTMLElement;
	private readonly rightContributedItemsContainer: HTMLElement;
	private readonly itemsDisposable: DisposableStore;

	private currentContext: INotebookCellActionContext | undefined;
	protected readonly _onDidClick: Emitter<IClickTarget> = this._register(new Emitter<IClickTarget>());
	readonly onDidClick: Event<IClickTarget> = this._onDidClick.event;

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.statusBarContainer = DOM.append(container, $('.cell-statusbar-container'));
		this.statusBarContainer.tabIndex = -1;
		const leftItemsContainer = DOM.append(this.statusBarContainer, $('.cell-status-left'));
		const rightItemsContainer = DOM.append(this.statusBarContainer, $('.cell-status-right'));
		this.cellRunStatusContainer = DOM.append(leftItemsContainer, $('.cell-run-status'));
		this.durationContainer = DOM.append(leftItemsContainer, $('.cell-run-duration'));
		this.leftContributedItemsContainer = DOM.append(leftItemsContainer, $('.cell-contributed-items.cell-contributed-items-left'));
		this.rightContributedItemsContainer = DOM.append(rightItemsContainer, $('.cell-contributed-items.cell-contributed-items-right'));

		this.itemsDisposable = this._register(new DisposableStore());

		this._register(DOM.addDisposableListener(this.statusBarContainer, DOM.EventType.CLICK, e => {
			if (e.target === leftItemsContainer || e.target === rightItemsContainer || e.target === this.statusBarContainer) {
				// hit on empty space
				this._onDidClick.fire({
					type: ClickTargetType.Container,
					event: e
				});
			} else if (e.target && (
				this.cellRunStatusContainer.contains(e.target as Node)
				|| this.durationContainer.contains(e.target as Node)
			)) {
				this._onDidClick.fire({
					type: ClickTargetType.CellStatus,
					event: e
				});
			} else {
				if ((e.target as HTMLElement).classList.contains('cell-status-item-has-command')) {
					this._onDidClick.fire({
						type: ClickTargetType.ContributedCommandItem,
						event: e
					});
				} else {
					// text
					this._onDidClick.fire({
						type: ClickTargetType.ContributedTextItem,
						event: e
					});
				}
			}
		}));
	}

	update(context: INotebookCellActionContext) {
		this.currentContext = context;
		this.itemsDisposable.clear();
		this.updateStatusBarItems();
	}

	layout(width: number): void {
		this.statusBarContainer.style.width = `${width}px`;
	}

	private async updateStatusBarItems() {
		if (!this.currentContext) {
			return;
		}

		this.itemsDisposable.add(this.currentContext.notebookEditor.onDidChangeActiveCell(() => this.updateActiveCell()));
		this.itemsDisposable.add(this.currentContext.cell.onDidChangeCellStatusBarItems(() => this.updateRenderedItems()));
		this.updateActiveCell();
		this.updateRenderedItems();
	}

	private updateActiveCell(): void {
		const isActiveCell = this.currentContext!.notebookEditor.getActiveCell() === this.currentContext?.cell;
		this.statusBarContainer.classList.toggle('is-active-cell', isActiveCell);
	}

	private updateRenderedItems(): void {
		DOM.clearNode(this.leftContributedItemsContainer);
		DOM.clearNode(this.rightContributedItemsContainer);

		const items = this.currentContext!.cell.getCellStatusBarItems();
		items.sort((itemA, itemB) => {
			return (itemB.priority ?? 0) - (itemA.priority ?? 0);
		});
		items.forEach(item => {
			const itemView = this.itemsDisposable.add(this.instantiationService.createInstance(CellStatusBarItem, this.currentContext!, item));
			if (item.alignment === CellStatusbarAlignment.Left) {
				this.leftContributedItemsContainer.appendChild(itemView.container);
			} else {
				this.rightContributedItemsContainer.appendChild(itemView.container);
			}
		});
	}
}

class CellStatusBarItem extends Disposable {

	readonly container = $('.cell-status-item');

	constructor(
		private readonly _context: INotebookCellActionContext,
		private readonly _itemModel: INotebookCellStatusBarItem,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
		new SimpleIconLabel(this.container).text = this._itemModel.text;

		if (this._itemModel.opacity) {
			this.container.style.opacity = this._itemModel.opacity;
		}

		if (this._itemModel.onlyShowWhenActive) {
			this.container.classList.add('cell-status-item-show-when-active');
		}

		let ariaLabel: string;
		let role: string | undefined;
		if (this._itemModel.accessibilityInformation) {
			ariaLabel = this._itemModel.accessibilityInformation.label;
			role = this._itemModel.accessibilityInformation.role;
		} else {
			ariaLabel = this._itemModel.text ? stripIcons(this._itemModel.text).trim() : '';
		}

		if (ariaLabel) {
			this.container.setAttribute('aria-label', ariaLabel);
		}

		if (role) {
			this.container.setAttribute('role', role);
		}

		this.container.title = this._itemModel.tooltip ?? '';

		if (this._itemModel.command) {
			this.container.classList.add('cell-status-item-has-command');
			this.container.tabIndex = 0;

			this._register(DOM.addDisposableListener(this.container, DOM.EventType.CLICK, _e => {
				this.executeCommand();
			}));
			this._register(DOM.addDisposableListener(this.container, DOM.EventType.KEY_UP, e => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Space) || event.equals(KeyCode.Enter)) {
					this.executeCommand();
				}
			}));
		}
	}

	private async executeCommand(): Promise<void> {
		const command = this._itemModel.command;
		if (!command) {
			return;
		}

		const id = typeof command === 'string' ? command : command.id;
		const args = typeof command === 'string' ? [] : command.arguments ?? [];

		args.unshift(this._context);

		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id, from: 'cell status bar' });
		try {
			await this.commandService.executeCommand(id, ...args);
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
		}
	}
}

declare const ResizeObserver: any;

export interface IResizeObserver {
	startObserving: () => void;
	stopObserving: () => void;
	getWidth(): number;
	getHeight(): number;
	dispose(): void;
}

export class BrowserResizeObserver extends Disposable implements IResizeObserver {
	private readonly referenceDomElement: HTMLElement | null;

	private readonly observer: any;
	private width: number;
	private height: number;

	constructor(referenceDomElement: HTMLElement | null, dimension: IDimension | undefined, changeCallback: () => void) {
		super();

		this.referenceDomElement = referenceDomElement;
		this.width = -1;
		this.height = -1;

		this.observer = new ResizeObserver((entries: any) => {
			for (const entry of entries) {
				if (entry.target === referenceDomElement && entry.contentRect) {
					if (this.width !== entry.contentRect.width || this.height !== entry.contentRect.height) {
						this.width = entry.contentRect.width;
						this.height = entry.contentRect.height;
						DOM.scheduleAtNextAnimationFrame(() => {
							changeCallback();
						});
					}
				}
			}
		});
	}

	getWidth(): number {
		return this.width;
	}

	getHeight(): number {
		return this.height;
	}

	startObserving(): void {
		this.observer.observe(this.referenceDomElement!);
	}

	stopObserving(): void {
		this.observer.unobserve(this.referenceDomElement!);
	}

	override dispose(): void {
		this.observer.disconnect();
		super.dispose();
	}
}

export function getResizesObserver(referenceDomElement: HTMLElement | null, dimension: IDimension | undefined, changeCallback: () => void): IResizeObserver {
	if (ResizeObserver) {
		return new BrowserResizeObserver(referenceDomElement, dimension, changeCallback);
	} else {
		return new ElementSizeObserver(referenceDomElement, dimension, changeCallback);
	}
}
