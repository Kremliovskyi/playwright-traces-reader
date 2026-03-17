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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const index_1 = require("../src/index");
const TRACE_ZIP = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
const TRACE_DIR = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
// Use the already-extracted directory if available, otherwise the zip
const tracePath = fs.existsSync(TRACE_DIR) ? TRACE_DIR : TRACE_ZIP;
describe('playwright-traces-reader sanity', () => {
    let ctx;
    beforeAll(async () => {
        ctx = await (0, index_1.prepareTraceDir)(tracePath);
    });
    test('prepareTraceDir resolves to a valid directory', () => {
        expect(ctx.traceDir).toBeTruthy();
        expect(fs.existsSync(ctx.traceDir)).toBe(true);
        const testTrace = path.join(ctx.traceDir, 'test.trace');
        expect(fs.existsSync(testTrace)).toBe(true);
    });
    test('getFailedTests returns at least one failure with error details', async () => {
        const failures = await (0, index_1.getFailedTests)(ctx);
        expect(failures.length).toBeGreaterThan(0);
        const first = failures[0];
        expect(first.callId).toBeTruthy();
        expect(first.title).toBeTruthy();
        expect(first.error).toBeTruthy();
        expect(typeof first.error.message).toBe('string');
        expect(first.error.message.length).toBeGreaterThan(0);
    });
    test('getTestSteps returns a non-empty step tree with durations', async () => {
        const steps = await (0, index_1.getTestSteps)(ctx);
        expect(steps.length).toBeGreaterThan(0);
        // At least some steps should have computed durations
        function flatten(ss) {
            return ss.flatMap(s => [s, ...flatten(s.children)]);
        }
        const all = flatten(steps);
        const withDuration = all.filter(s => s.durationMs !== null);
        expect(withDuration.length).toBeGreaterThan(0);
    });
    test('getNetworkTraffic resolves response bodies from resources/', async () => {
        const traffic = await (0, index_1.getNetworkTraffic)(ctx);
        expect(traffic.length).toBeGreaterThan(0);
        // Expect at least one entry with a resolved JSON response body
        const jsonEntry = traffic.find(e => e.mimeType.includes('json') && e.responseBody !== null);
        expect(jsonEntry).toBeDefined();
        if (jsonEntry?.responseBody) {
            expect(() => JSON.parse(jsonEntry.responseBody)).not.toThrow();
        }
    });
    test('getNetworkTraffic separates browser and api traffic', async () => {
        const traffic = await (0, index_1.getNetworkTraffic)(ctx);
        const apiTraffic = traffic.filter(e => e.source === 'api');
        const browserTraffic = traffic.filter(e => e.source === 'browser');
        // This trace has both browser and API traffic
        expect(apiTraffic.length).toBeGreaterThan(0);
        expect(browserTraffic.length).toBeGreaterThan(0);
    });
    test('extractScreenshots saves .jpeg files to the output directory', async () => {
        const outDir = path.join(os.tmpdir(), 'pw-screenshots-sanity-test', Date.now().toString());
        const screenshots = await (0, index_1.extractScreenshots)(ctx, outDir);
        expect(screenshots.length).toBeGreaterThan(0);
        for (const s of screenshots) {
            expect(fs.existsSync(s.savedPath)).toBe(true);
            const stat = fs.statSync(s.savedPath);
            expect(stat.size).toBeGreaterThan(0);
        }
        // Cleanup
        await fs.promises.rm(outDir, { recursive: true, force: true });
    });
});
//# sourceMappingURL=sanity.test.js.map