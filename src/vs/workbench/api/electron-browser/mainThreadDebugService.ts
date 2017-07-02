/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IDebugService, IProcess, IConfig } from 'vs/workbench/parts/debug/common/debug';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtHostContext, ExtHostDebugServiceShape, MainThreadDebugServiceShape, DebugSessionUUID } from '../node/extHost.protocol';

export class MainThreadDebugService extends MainThreadDebugServiceShape {

	private _proxy: ExtHostDebugServiceShape;
	private _toDispose: IDisposable[];

	constructor(
		@IThreadService threadService: IThreadService,
		@IDebugService private debugService: IDebugService
	) {
		super();
		this._proxy = threadService.get(ExtHostContext.ExtHostDebugService);
		this._toDispose = [];
		this._toDispose.push(debugService.onDidEndProcess(proc => this._proxy.$acceptDebugSessionTerminated(<DebugSessionUUID>proc.getId(), proc.configuration.type, proc.name)));
	}

	public dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	public $createDebugSession(configuration: IConfig): TPromise<DebugSessionUUID> {
		if (configuration.request !== 'launch' && configuration.request !== 'attach') {
			return TPromise.wrapError(new Error(`only 'launch' or 'attach' allowed for 'request' attribute`));
		}
		return this.debugService.createProcess(configuration).then(process => {
			if (process) {
				return <DebugSessionUUID>process.getId();
			}
			return TPromise.wrapError(new Error('cannot create debug session'));
		}, err => {
			return TPromise.wrapError(err && err.message ? err.message : 'cannot create debug session');
		});
	}

	public $customDebugAdapterRequest(sessionId: DebugSessionUUID, request: string, args: any): TPromise<any> {
		const process = this._findProcessByUUID(sessionId);
		if (process) {
			return process.session.custom(request, args).then(response => {
				if (response.success) {
					return response.body;
				} else {
					return TPromise.wrapError(new Error(response.message));
				}
			});
		}
		return TPromise.wrapError(new Error('debug session not found'));
	}

	private _findProcessByUUID(processId: DebugSessionUUID): IProcess | null {
		const processes = this.debugService.getModel().getProcesses();
		const result = processes.filter(process => process.getId() === processId);
		if (result.length > 0) {
			return processes[0];	// there can only be one
		}
		return null;
	}
}
