/**
 * Browser-facing application ports. These typedefs intentionally have no
 * implementation dependency so services can be exercised under Node tests.
 *
 * @typedef {{ get(key:string, fallback?:unknown):unknown, set(key:string, value:unknown):void, remove(key:string):void }} PreferencesPort
 * @typedef {{ read():Promise<unknown>, write(value:unknown):Promise<void> }} ClipboardPort
 * @typedef {{ encode(bitmap:unknown):Promise<Uint8Array>, decode(bytes:Uint8Array):Promise<unknown> }} ImageCodecPort
 */

export const APPLICATION_PORTS_VERSION = 1;
