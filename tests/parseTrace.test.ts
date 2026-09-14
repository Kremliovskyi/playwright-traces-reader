import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import AdmZip from "adm-zip";
import {
  NdjsonParseError,
  UnsupportedTraceVersionError,
  extractAttachment,
  extractScreenshots,
  getAttachments,
  getDomSnapshots,
  getNetworkTraffic,
  getResourceBuffer,
  getTestSteps,
  inspectTraceCompatibility,
  listTraces,
  prepareTraceDir,
  readNdjson,
} from "../src";

async function collect<T>(values: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function writeTraceZip(zipPath: string, marker: string): void {
  const zip = new AdmZip();
  zip.addFile(
    "test.trace",
    Buffer.from(`${JSON.stringify({ type: "before", title: marker })}\n`),
  );
  zip.addFile(
    "0-trace.trace",
    Buffer.from(
      `${JSON.stringify({
        type: "context-options",
        version: 8,
        playwrightVersion: "1.59.0",
      })}\n`,
    ),
  );
  zip.writeZip(zipPath);
}

describe("trace parsing", () => {
  test("rejects malformed NDJSON with its file and line number", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-parse-"),
    );
    const traceFile = path.join(tempDir, "test.trace");

    try {
      await fs.promises.writeFile(
        traceFile,
        '{"type":"before"}\n{"type":\n',
        "utf8",
      );

      await expect(collect(readNdjson(traceFile))).rejects.toMatchObject({
        name: "NdjsonParseError",
        filePath: traceFile,
        lineNumber: 2,
      } satisfies Partial<NdjsonParseError>);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("accepts blank lines between valid NDJSON events", async () => {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-parse-"),
    );
    const traceFile = path.join(tempDir, "test.trace");

    try {
      await fs.promises.writeFile(
        traceFile,
        '{"type":"before"}\n\n{"type":"after"}\n',
        "utf8",
      );

      await expect(
        collect(readNdjson<{ type: string }>(traceFile)),
      ).resolves.toEqual([{ type: "before" }, { type: "after" }]);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects a trace schema newer than the validated maximum", async () => {
    const traceDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-future-"),
    );

    try {
      await fs.promises.writeFile(
        path.join(traceDir, "test.trace"),
        "",
        "utf8",
      );
      await fs.promises.writeFile(
        path.join(traceDir, "0-trace.trace"),
        `${JSON.stringify({ type: "context-options", version: 11, playwrightVersion: "future" })}\n`,
        "utf8",
      );

      await expect(prepareTraceDir(traceDir)).rejects.toMatchObject({
        name: "UnsupportedTraceVersionError",
        traceVersion: 11,
        maxSupportedVersion: 10,
      } satisfies Partial<UnsupportedTraceVersionError>);
    } finally {
      await fs.promises.rm(traceDir, { recursive: true, force: true });
    }
  });

  test("reports trace versions, event counts, and missing resources", async () => {
    const traceDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-inspect-"),
    );
    const resourcesDir = path.join(traceDir, "resources");

    try {
      await fs.promises.mkdir(resourcesDir);
      await fs.promises.writeFile(
        path.join(resourcesDir, "present.jpeg"),
        "image",
      );
      await fs.promises.writeFile(
        path.join(traceDir, "test.trace"),
        `${JSON.stringify({ type: "before", callId: "call@1" })}\n`,
      );
      await fs.promises.writeFile(
        path.join(traceDir, "0-trace.trace"),
        [
          JSON.stringify({
            type: "context-options",
            version: 8,
            playwrightVersion: "1.59.0",
          }),
          JSON.stringify({ type: "screencast-frame", sha1: "present.jpeg" }),
        ].join("\n") + "\n",
      );
      await fs.promises.writeFile(
        path.join(traceDir, "0.network"),
        `${JSON.stringify({
          type: "resource-snapshot",
          snapshot: { response: { content: { _sha1: "missing.json" } } },
        })}\n`,
      );

      const traceContext = await prepareTraceDir(traceDir);
      const report = await inspectTraceCompatibility(traceContext);

      expect(report).toMatchObject({
        traceVersion: 8,
        playwrightVersions: ["1.59.0"],
        eventTypes: {
          before: 1,
          "context-options": 1,
          "resource-snapshot": 1,
          "screencast-frame": 1,
        },
        referencedResources: ["missing.json", "present.jpeg"],
        missingResources: ["missing.json"],
      });
      expect(report.files.map((file) => file.file)).toEqual([
        "0-trace.trace",
        "0.network",
        "test.trace",
      ]);
    } finally {
      await fs.promises.rm(traceDir, { recursive: true, force: true });
    }
  });

  test.each([8, 9, 10])(
    "reads schema %i actions and trace-relative resources while retaining legacy lookup",
    async (traceVersion) => {
      const traceDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pwtr-relative-resources-"),
      );
      const stepId = "pw:api@1";
      const callId = traceVersion >= 10 ? stepId : "call@1";

      try {
        await fs.promises.mkdir(path.join(traceDir, "resources"));
        await fs.promises.mkdir(path.join(traceDir, "screencast"));
        await fs.promises.mkdir(path.join(traceDir, "attachments"));
        await fs.promises.writeFile(
          path.join(traceDir, "resources", "request.json"),
          '{"request":true}',
        );
        await fs.promises.writeFile(
          path.join(traceDir, "resources", "response.json"),
          '{"response":true}',
        );
        await fs.promises.writeFile(
          path.join(traceDir, "screencast", "frame.jpeg"),
          Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        );
        await fs.promises.writeFile(
          path.join(traceDir, "attachments", "artifact.txt"),
          "relative attachment",
        );
        await fs.promises.writeFile(
          path.join(traceDir, "test.trace"),
          [
            JSON.stringify({
              type: "before",
              callId: stepId,
              title: "relative resources",
              startTime: 1,
            }),
            JSON.stringify({ type: "after", callId: stepId, endTime: 2 }),
          ].join("\n") + "\n",
          "utf8",
        );
        await fs.promises.writeFile(
          path.join(traceDir, "0-trace.trace"),
          [
            JSON.stringify({
              type: "context-options",
              version: traceVersion,
              playwrightVersion: "synthetic",
            }),
            JSON.stringify({
              type: "before",
              callId,
              ...(traceVersion < 10 ? { stepId } : {}),
              title: "relative resources",
            }),
            JSON.stringify({
              type: "frame-snapshot",
              snapshot: {
                callId,
                ...(traceVersion < 9
                  ? { snapshotName: `input@${callId}` }
                  : { phase: "action" }),
                frameId: "frame@1",
                frameUrl: "https://example.test/resource",
                pageId: "page@1",
                timestamp: 1,
                viewport: { width: 100, height: 50 },
                isMainFrame: true,
                html: ["BUTTON", { __playwright_target__: callId }, "Submit"],
                resourceOverrides: [],
              },
            }),
            JSON.stringify({
              type: "screencast-frame",
              pageId: "page@1",
              file: "screencast/frame.jpeg",
              width: 100,
              height: 50,
              timestamp: 1,
            }),
            JSON.stringify({
              type: "after",
              callId,
              endTime: 2,
              attachments: [
                {
                  name: "artifact.txt",
                  contentType: "text/plain",
                  file: "attachments/artifact.txt",
                },
              ],
            }),
          ].join("\n") + "\n",
        );
        await fs.promises.writeFile(
          path.join(traceDir, "0.network"),
          `${JSON.stringify({
            type: "resource-snapshot",
            snapshot: {
              _apiRequestRef: "request-context@1",
              startedDateTime: "2026-08-17T00:00:00.000Z",
              time: 1,
              _monotonicTime: 1,
              request: {
                method: "POST",
                url: "https://example.test/resource",
                headers: [],
                postData: {
                  mimeType: "application/json",
                  _file: "resources/request.json",
                },
              },
              response: {
                status: 422,
                statusText: "Unprocessable Entity",
                headers: [],
                content: {
                  size: 17,
                  mimeType: "application/json",
                  _file: "resources/response.json",
                },
              },
            },
          })}\n`,
        );

        const traceContext = await prepareTraceDir(traceDir);
        const steps = await getTestSteps(traceContext);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({
          callId: stepId,
          title: "relative resources",
          durationMs: 1,
        });
        const snapshots = await getDomSnapshots(traceContext);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({
          callId,
          action: {
            callId,
            snapshotName: `input@${callId}`,
            html: expect.stringContaining("Submit"),
            targetElement: callId,
          },
        });
        const network = await getNetworkTraffic(traceContext);
        expect(network).toHaveLength(1);
        expect(network[0]).toMatchObject({
          source: "api",
          requestBody: '{"request":true}',
          responseBody: '{"response":true}',
        });

        const screenshots = await extractScreenshots(
          traceContext,
          path.join(traceDir, "output-screenshots"),
        );
        expect(screenshots).toHaveLength(1);
        expect(screenshots[0]).toMatchObject({
          sha1: "screencast/frame.jpeg",
          file: "screencast/frame.jpeg",
        });

        const attachments = await getAttachments(traceContext);
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toMatchObject({
          file: "attachments/artifact.txt",
          size: 19,
        });
        const saved = await extractAttachment(
          traceContext,
          attachments[0]!.id,
          path.join(traceDir, "artifact.txt"),
        );
        expect(await fs.promises.readFile(saved.savedPath, "utf8")).toBe(
          "relative attachment",
        );

        const compatibility = await inspectTraceCompatibility(traceContext);
        expect(compatibility.traceVersion).toBe(traceVersion);
        expect(compatibility.referencedResources).toEqual([
          "attachments/artifact.txt",
          "resources/request.json",
          "resources/response.json",
          "screencast/frame.jpeg",
        ]);
        expect(compatibility.missingResources).toEqual([]);

        expect(
          (await getResourceBuffer(traceContext, "request.json"))?.toString(
            "utf8",
          ),
        ).toBe('{"request":true}');
        await expect(
          getResourceBuffer(traceContext, "../outside.txt"),
        ).rejects.toThrow("Invalid trace resource path");
        await expect(
          getResourceBuffer(traceContext, "resources/../test.trace"),
        ).rejects.toThrow("Invalid trace resource path");
      } finally {
        await fs.promises.rm(traceDir, { recursive: true, force: true });
      }
    },
  );

  test("extracts ZIP traces atomically without modifying their source directory", async () => {
    const dataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-zip-"),
    );
    const zipPath = path.join(dataDir, "trace-sha.zip");
    const marker = crypto.randomUUID();
    let cacheEntryRoot: string | undefined;
    writeTraceZip(zipPath, marker);

    try {
      const contexts = await Promise.all([
        prepareTraceDir(zipPath),
        prepareTraceDir(zipPath),
        prepareTraceDir(zipPath),
      ]);
      cacheEntryRoot = path.dirname(contexts[0]!.traceDir);

      expect(new Set(contexts.map((context) => context.traceDir)).size).toBe(1);
      expect(path.basename(contexts[0]!.traceDir)).toBe("trace-sha");
      expect(contexts[0]!.sourcePath).toBe(zipPath);
      expect(contexts[0]!.reportDataDir).toBe(dataDir);
      expect(fs.existsSync(path.join(dataDir, "trace-sha"))).toBe(false);
      expect(
        await fs.promises.readFile(
          path.join(contexts[0]!.traceDir, "test.trace"),
          "utf8",
        ),
      ).toContain(marker);
      expect(fs.existsSync(path.join(cacheEntryRoot, ".last-access"))).toBe(
        true,
      );
    } finally {
      if (cacheEntryRoot)
        await fs.promises.rm(cacheEntryRoot, { recursive: true, force: true });
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("accepts a completed cache entry when Windows reports EPERM for a competing rename", async () => {
    const dataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-eperm-"),
    );
    const zipPath = path.join(dataDir, "trace-sha.zip");
    const marker = crypto.randomUUID();
    writeTraceZip(zipPath, marker);
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(zipPath))
      .digest("hex");
    const cacheRoot = path.join(
      os.tmpdir(),
      "playwright-traces-reader",
      "trace-cache",
    );
    const finalRoot = path.join(cacheRoot, digest);

    const renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (source, destination) => {
        await fs.promises.cp(source, destination, { recursive: true });
        throw Object.assign(
          new Error(
            `EPERM: operation not permitted, rename '${source}' -> '${destination}'`,
          ),
          {
            code: "EPERM",
          },
        );
      });

    try {
      const context = await prepareTraceDir(zipPath);

      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(
        await fs.promises.readFile(
          path.join(context.traceDir, "test.trace"),
          "utf8",
        ),
      ).toContain(marker);
      const cacheEntries = await fs.promises.readdir(cacheRoot);
      expect(cacheEntries.some((entry) => entry.startsWith(`${digest}-`))).toBe(
        false,
      );
    } finally {
      renameSpy.mockRestore();
      await fs.promises.rm(finalRoot, { recursive: true, force: true });
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("uses new archive bytes instead of a stale extraction", async () => {
    const dataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-refresh-"),
    );
    const zipPath = path.join(dataDir, "trace-sha.zip");

    try {
      writeTraceZip(zipPath, "first");
      const first = await prepareTraceDir(zipPath);

      writeTraceZip(zipPath, "second-with-different-bytes");
      const second = await prepareTraceDir(zipPath);

      expect(second.traceDir).not.toBe(first.traceDir);
      expect(path.basename(second.traceDir)).toBe(
        path.basename(first.traceDir),
      );
      expect(
        await fs.promises.readFile(
          path.join(second.traceDir, "test.trace"),
          "utf8",
        ),
      ).toContain("second-with-different-bytes");
      expect(fs.existsSync(path.join(dataDir, "trace-sha"))).toBe(false);
    } finally {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("prefers a report archive over a stale extracted sibling", async () => {
    const dataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pwtr-stale-"),
    );
    const zipPath = path.join(dataDir, "trace-sha.zip");
    const staleDir = path.join(dataDir, "trace-sha");

    try {
      writeTraceZip(zipPath, "archive-marker");
      await fs.promises.mkdir(staleDir);
      await fs.promises.writeFile(
        path.join(staleDir, "test.trace"),
        `${JSON.stringify({ type: "before", title: "stale-marker" })}\n`,
      );

      const traces = await listTraces(dataDir);

      expect(traces).toHaveLength(1);
      expect(traces[0]!.sourcePath).toBe(zipPath);
      expect(
        await fs.promises.readFile(
          path.join(traces[0]!.traceDir, "test.trace"),
          "utf8",
        ),
      ).toContain("archive-marker");
    } finally {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });
});
