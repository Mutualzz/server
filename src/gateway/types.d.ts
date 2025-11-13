declare module "@yukikaze-bot/erlpack" {
    export function pack(data: any): Uint8Array;
    export function unpack(data: Buffer | Uint8Array): any;
}
