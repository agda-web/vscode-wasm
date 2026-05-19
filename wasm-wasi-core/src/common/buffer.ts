import { size } from './baseTypes';

export function read(content: Uint8Array, offset: number, buffers: Uint8Array[]): size {
	let totalBytesRead = 0;
	for (const buffer of buffers) {
		const toRead = Math.min(buffer.length, content.byteLength - offset);
		buffer.set(content.subarray(offset, offset + toRead));
		totalBytesRead += toRead;
		if (toRead < buffer.length) {
			break;
		}
		offset += toRead;
	}
	return totalBytesRead;
}

// copied from TS's es2024.arraybuffer.d.ts
interface MaybeResizableArrayBuffer extends ArrayBuffer {
	get maxByteLength(): number;
	get resizable(): boolean;
	resize: (newByteLength?: number) => void;
}

interface ResizableArrayBufferConstructor extends ArrayBufferConstructor {
	new (byteLength: number, options?: { maxByteLength?: number; }): MaybeResizableArrayBuffer;
}

declare const ArrayBuffer: ResizableArrayBufferConstructor;

let isArrayBufferResizingSupported: boolean | undefined = undefined;
function canResizeArrayBuffers() {
  if (isArrayBufferResizingSupported !== undefined) {
  	return isArrayBufferResizingSupported;
  }
  const ab = new ArrayBuffer(1, { maxByteLength: 4 });
  return (isArrayBufferResizingSupported = !!ab.resizable);
}

export function write(content: Uint8Array, offset: number, buffers: Uint8Array[], forceNonResizable = false): [Uint8Array, size] {
	let bytesToWrite: size = 0;
	for (const bytes of buffers) {
		bytesToWrite += bytes.byteLength;
	}

	const newSize = offset + bytesToWrite;

	// Do we need to enlarge the buffer?
	if (newSize > content.byteLength) {
		if (!canResizeArrayBuffers()) {
			// resizing is unsupported; fallback to always copying over
			const newContent = new Uint8Array(offset + bytesToWrite);
			newContent.set(content);
			content = newContent;
		} else {
			// Utilize ECMAScript 2024 In-Place Resizable ArrayBuffers
			const oldBuffer = content.buffer as MaybeResizableArrayBuffer;

			const oldSize = oldBuffer.maxByteLength;

			if (newSize < oldSize) {
				// content.byteLength < newSize < oldSize = content.buffer.maxByteLength;
				// hence the buffer must be resizable
				oldBuffer.resize(newSize);
			} else if (newSize > oldSize) {
				const newBuffer = new ArrayBuffer(newSize, { maxByteLength: Math.max(newSize, oldSize << 1) });
				const newContent = new Uint8Array(newBuffer);
				newContent.set(content);
				content = newContent;
			}

			if (forceNonResizable && (content.buffer as MaybeResizableArrayBuffer).resizable) {
				content = new Uint8Array(content.buffer.slice(0));
			}
		}
	}

	for (const bytes of buffers) {
		content.set(bytes, offset);
		offset += bytes.length;
	}

	return [content, bytesToWrite];
}