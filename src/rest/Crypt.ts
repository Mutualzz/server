import Cryptr from "cryptr";

const { SECRET } = process.env;
if (!SECRET) throw new Error("No secret provided");

export const encrypt = (str: string) => new Cryptr(SECRET).encrypt(str);
export const decrypt = (str: string) => new Cryptr(SECRET).decrypt(str);
