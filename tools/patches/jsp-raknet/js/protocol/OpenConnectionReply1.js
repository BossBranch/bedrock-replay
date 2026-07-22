"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Identifiers = require('./Identifiers');
const OfflinePacket_1 = __importDefault(require("./OfflinePacket"));
class OpenConnectionReply1 extends OfflinePacket_1.default {
    constructor(buffer) {
        super(Identifiers.OpenConnectionReply1, buffer);
        this.security = false;
        this.cookie = null;
    }
    decode() {
        super.decode();
        this.readMagic();
        this.serverGUID = this.readLong();
        // Bedrock servers may set security=true and append a 4-byte cookie (anti-amplification)
        this.security = this.readBool();
        this.cookie = this.security ? this.readInt() : null;
        this.mtuSize = this.readShort();
    }
    encode() {
        super.encode();
        this.writeMagic();
        this.writeLong(this.serverGUID);
        // Hub as server: no cookie (real clients still connect)
        this.writeBool(false);
        this.writeShort(this.mtuSize);
    }
}
exports.default = OpenConnectionReply1;
