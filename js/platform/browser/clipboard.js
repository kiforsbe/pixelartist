export class BrowserClipboard {
  async read() {
    if (!globalThis.navigator?.clipboard?.read) throw new Error('Clipboard read is not available');
    return navigator.clipboard.read();
  }

  async write(items) {
    if (!globalThis.navigator?.clipboard?.write) throw new Error('Clipboard write is not available');
    return navigator.clipboard.write(items);
  }
}
