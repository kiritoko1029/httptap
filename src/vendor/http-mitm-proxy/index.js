// vendored from http-mitm-proxy@1.1.0 (https://github.com/joeferner/node-http-mitm-proxy)
// MIT License, (c) Joe Ferner <joe@fernsroth.com>
// httptap 的本地改动：lib/proxy.js 里 uuid 换成 Node 内置 crypto.randomUUID；未打包 bin/（yargs CLI，未使用）
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Proxy = void 0;
var proxy_1 = require("./lib/proxy");
Object.defineProperty(exports, "Proxy", { enumerable: true, get: function () { return proxy_1.Proxy; } });
__exportStar(require("./lib/types"), exports);
//# sourceMappingURL=index.js.map