"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Identifiers = require('./Identifiers');
const OfflinePacket_1 = __importDefault(require("./OfflinePacket"));
class OpenConnectionRequest2 extends OfflinePacket_1.default {
    constructor(buffer) {
        super(Identifiers.OpenConnectionRequest2, buffer);
        this.cookie = null;
    }
    decode() {
        super.decode();
        this.readMagic();
        // Cookie fields only present when server sent security+cookie in Reply1.
        // Our hub does not send cookies, so inbound client Request2 has no cookie prefix.
        this.serverAddress = this.readAddress();
        this.mtuSize = this.readShort();
        this.clientGUID = this.readLong();
    }
    encode() {
        super.encode();
        this.writeMagic();
        if (this.cookie != null) {
            this.writeInt(this.cookie);
            this.writeBool(false); // clientSupportsSecurity — Bedrock always false
        }
        this.writeAddress(this.serverAddress);
        this.writeShort(this.mtuSize);
        this.writeLong(this.clientGUID);
    }
}
exports.default = OpenConnectionRequest2;
