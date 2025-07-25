/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Disposable, Event, EventEmitter } from 'vscode';

import type { Readable, Writable } from './api';
import { CapturedPromise } from './promises';
import RAL from './ral';

export class DestroyError extends Error {
	constructor() {
		super('Pipe got destroyed');
	}
}

export abstract class Stream {

	private static BufferSize = 16384;

	protected chunks: Uint8Array[];
	protected fillLevel: number;

	private awaitForFillLevel: { fillLevel: number; promise: CapturedPromise<void> }[];
	private awaitForData: CapturedPromise<void>[];

	constructor() {
		this.chunks = [];
		this.fillLevel = 0;
		this.awaitForFillLevel = [];
		this.awaitForData = [];
	}

	public get size(): number {
		return this.fillLevel;
	}

	public ready() {
		return this.fillLevel > 0;
	}

	public async write(chunk: Uint8Array): Promise<void> {
		// We don't write chunks of size 0 since they would indicate the end of the stream
		// on the receiving side. If we want to support closing a stream via a write we should
		// support writing null.
		if (chunk.byteLength === 0) {
			return;
		}
		// We have enough space
		if (this.fillLevel + chunk.byteLength <= Stream.BufferSize) {
			this.chunks.push(chunk);
			this.fillLevel += chunk.byteLength;
			this.signalData();
			return;
		}
		// Wait for the necessary space.
		const targetFillLevel = Math.max(0, Stream.BufferSize - chunk.byteLength);
		try {
			await this.awaitFillLevel(targetFillLevel);
			if (this.fillLevel > targetFillLevel) {
				throw new Error(`Invalid state: fillLevel should be <= ${targetFillLevel}`);
			}
			this.chunks.push(chunk);
			this.fillLevel += chunk.byteLength;
			this.signalData();
			return;
		} catch (error) {
			if (error instanceof DestroyError) {
				return;
			}
			throw error;
		}
	}

	public async pollRead(): Promise<void> {
		if (this.ready()) {
			return;
		}
		await this.awaitData();
	}

	public async read(): Promise<Uint8Array>;
	public async read(mode: 'max', size: number): Promise<Uint8Array>;
	public async read(mode?: 'max', size?: number): Promise<Uint8Array> {
		const maxBytes = mode === 'max' ? size : undefined;
		if (this.chunks.length === 0) {
			try {
				await this.awaitData();
			} catch (error) {
				if (error instanceof DestroyError) {
					return new Uint8Array(0);
				}
				throw error;
			}
		}
		if (this.chunks.length === 0) {
			throw new Error('Invalid state: no bytes available after awaiting data');
		}
		// No max bytes or all data fits into the result.
		if (maxBytes === undefined || maxBytes > this.fillLevel) {
			const result = new Uint8Array(this.fillLevel);
			let offset = 0;
			for (const chunk of this.chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}
			this.chunks = [];
			this.fillLevel = 0;
			this.signalSpace();
			return result;
		}

		const chunk = this.chunks[0];
		// The first chunk is bigger than the maxBytes. Although not optimal we need
		// to split it up
		if (chunk.byteLength > maxBytes) {
			const result = chunk.subarray(0, maxBytes);
			this.chunks[0] = chunk.subarray(maxBytes);
			this.fillLevel -= maxBytes;
			this.signalSpace();
			return result;
		} else {
			let resultSize = chunk.byteLength;
			for (let i = 1; i < this.chunks.length; i++) {
				if (resultSize + this.chunks[i].byteLength > maxBytes) {
					break;
				}
				resultSize += this.chunks[i].byteLength;
			}
			const result = new Uint8Array(resultSize);
			let offset = 0;
			while (offset < resultSize) {
				const chunk = this.chunks.shift()!;
				result.set(chunk, offset);
				offset += chunk.byteLength;
				this.fillLevel -= chunk.byteLength;
			}
			this.signalSpace();
			return result;
		}
	}

	public end(): void {
	}

	public destroy(): void {
		this.chunks = [];
		this.fillLevel = 0;
		const error = new DestroyError();
		for (const { promise } of this.awaitForFillLevel) {
			promise.reject(error);
		}
		this.awaitForFillLevel = [];
		for (const promise of this.awaitForData) {
			promise.reject(error);
		}
		this.awaitForData = [];
	}

	private awaitFillLevel(targetFillLevel: number): Promise<void> {
		if (this.awaitForFillLevel.length === 0 && this.fillLevel <= targetFillLevel) {
			return Promise.resolve();
		}
		const result = CapturedPromise.create<void>();
		this.awaitForFillLevel.push({ fillLevel: targetFillLevel, promise: result });
		return result.promise;
	}

	private awaitData(): Promise<void> {
		const result = CapturedPromise.create<void>();
		this.awaitForData.push(result);
		return result.promise;
	}

	protected signalSpace(): void {
		if (this.awaitForFillLevel.length === 0) {
			return;
		}
		const { fillLevel, promise } = this.awaitForFillLevel[0];
		// Not enough space.
		if (this.fillLevel > fillLevel) {
			return;
		}
		this.awaitForFillLevel.shift();
		promise.resolve();
	}

	protected signalData(): void {
		if (this.awaitForData.length === 0) {
			return;
		}
		const promise = this.awaitForData.shift()!;
		promise.resolve();
	}

}

enum StreamState {
	open = 'open',
	closed = 'closed',
}

export class WritableStream extends Stream implements Writable {

	private readonly encoding: 'utf-8';
	private readonly encoder: RAL.TextEncoder;
	protected streamState: StreamState;

	constructor(encoding?: 'utf-8') {
		super();
		this.encoding = encoding ?? 'utf-8';
		this.encoder = RAL().TextEncoder.create(this.encoding);
		this.streamState = StreamState.open;
	}

	public ready() {
		if (this.streamState === StreamState.closed) {
			return true;
		}
		return super.ready();
	}

	public write(chunk: Uint8Array): Promise<void>;
	public write(chunk: string, encoding?: 'utf-8'): Promise<void>;
	public write(chunk: Uint8Array | string, _encoding?: 'utf-8'): Promise<void> {
		if (this.streamState !== StreamState.open) {
			return Promise.reject(new Error('Stream is closed'));
		}
		return super.write(typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk);
	}

	public read(): Promise<Uint8Array>;
	public read(mode: 'max', size: number): Promise<Uint8Array>;
	public read(mode?: 'max', size?: number): Promise<Uint8Array> {
		if (this.streamState === StreamState.closed && this.chunks.length === 0) {
			return Promise.resolve(new Uint8Array(0));
		}
		return mode !== undefined ? super.read(mode, size!) : super.read();
	}

	public end(): void {
		this.streamState = StreamState.closed;
	}
}

export class WritableStreamEOT extends WritableStream {

	constructor(encoding?: 'utf-8') {
		super(encoding);
	}

	public async write(chunk: Uint8Array | string, encoding?: 'utf-8'): Promise<void> {
		if (this.streamState !== StreamState.open) {
			throw new Error('Stream is closed');
		}
		let eot:boolean = false;
		try {
			if (typeof chunk === 'string') {
				if (chunk.length > 0 && chunk.charCodeAt(chunk.length - 1) === 0x04 /* EOT */) {
					eot = true;
					if (chunk.length >= 1) {
						chunk = chunk.substring(0, chunk.length - 1);
						await super.write(chunk, encoding);
					}
				} else {
					await super.write(chunk, encoding);
				}
			} else {
				if (chunk.length > 0 && chunk[chunk.length - 1] === 0x04 /* EOT */) {
					eot = true;
					if (chunk.length >= 1) {
						chunk = chunk.subarray(0, chunk.length - 1);
						await super.write(chunk);
					}
				} else {
					await super.write(chunk);
				}
			}
		} finally {
			if (eot) {
				this.streamState = StreamState.closed;
			}
		}
	}
}

enum ReadableStreamMode {
	initial,
	flowing,
	paused
}

export class ReadableStream extends Stream implements Readable {

	private mode: ReadableStreamMode;
	private readonly _onData: EventEmitter<Uint8Array>;
	private readonly _onDataEvent: Event<Uint8Array>;
	private timer: Disposable | undefined;

	constructor() {
		super();
		this.mode = ReadableStreamMode.initial;
		this._onData = new EventEmitter();
		this._onDataEvent = (listener, thisArgs?, disposables?) => {
			if (this.mode === ReadableStreamMode.initial) {
				this.mode = ReadableStreamMode.flowing;
			}
			return this._onData.event(listener, thisArgs, disposables);
		};
	}

	public get onData(): Event<Uint8Array> {
		return this._onDataEvent;
	}

	public pause(flush: boolean = false): void {
		// When we are in flowing mode emit all chunks as data events
		// before switching to paused mode.
		if (this.mode === ReadableStreamMode.flowing) {
			if (this.timer !== undefined) {
				this.timer.dispose();
				this.timer = undefined;
			}
			if (flush) {
				this.emitAll();
			}
		}
		this.mode = ReadableStreamMode.paused;
	}

	public resume(): void {
		this.mode = ReadableStreamMode.flowing;
		if (this.chunks.length > 0) {
			this.signalData();
		}
	}

	public async read(): Promise<Uint8Array>;
	public async read(mode: 'max', size: number): Promise<Uint8Array>;
	public async read(mode?: 'max', size?: number): Promise<Uint8Array> {
		if (this.mode === ReadableStreamMode.flowing) {
			throw new Error('Cannot read from stream in flowing mode');
		}
		return mode === undefined ? super.read() : super.read(mode, size!);
	}

	public end(): void {
		if (this.mode === ReadableStreamMode.flowing) {
			if (this.timer !== undefined) {
				this.timer.dispose();
				this.timer = undefined;
			}
			this.emitAll();
		}
		return super.destroy();
	}

	protected signalData(): void {
		if (this.mode === ReadableStreamMode.flowing) {
			if (this.timer !== undefined) {
				return;
			}
			this.timer = RAL().timer.setImmediate(() => this.triggerData());
		} else {
			super.signalData();
		}
	}

	private emitAll(): void {
		if (this.chunks.length > 0) {
			for (const chunk of this.chunks) {
				try {
					this._onData.fire(chunk);
				} catch (error) {
					RAL().console.error(`[ReadableStream]: Error while emitting data event: ${error}`);
				}
			}
			this.chunks = [];
			this.fillLevel = 0;
		}
	}

	private triggerData() {
		this.timer = undefined;
		if (this.chunks.length === 0) {
			return;
		}
		const chunk = this.chunks.shift()!;
		this.fillLevel -= chunk.byteLength;
		this._onData.fire(chunk);
		this.signalSpace();
		if (this.chunks.length > 0 && this.mode === ReadableStreamMode.flowing) {
			this.timer = RAL().timer.setImmediate(() => this.triggerData());
		}
	}
}