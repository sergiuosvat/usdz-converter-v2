import { Storage } from "@google-cloud/storage";
import { createWriteStream } from "fs";
import { mkdir, rm } from "node:fs/promises";
import { parse } from "path";
import winston from "winston";

const FILES_FOLDER = process.env.FILES_FOLDER || "/tmp/gltf2usdz/files";
const LOGS_FOLDER = process.env.LOGS_FOLDER || "/tmp/gltf2usdz/logs";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => `[${info.timestamp}] ${info.level}: ${info.message}`),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      maxsize: 20_000_000,
      maxFiles: 5,
      filename: `${LOGS_FOLDER}/app.log`,
      format: winston.format.timestamp(),
    }),
  ],
});

await mkdir(FILES_FOLDER, { recursive: true });
await mkdir(LOGS_FOLDER, { recursive: true });

// Initialize GCS client if credentials and bucket are provided through env
const GCS_BUCKET = Bun.env.GCS_BUCKET || process.env.GCS_BUCKET;
let storage: Storage | null = null;
if (GCS_BUCKET) {
  try {
    storage = new Storage();
    logger.info(`Google Cloud Storage client initialized for bucket ${GCS_BUCKET}`);
  } catch (err) {
    logger.warn(`Failed to initialize Google Cloud Storage client: ${String(err)}`);
    storage = null;
  }
} else {
  logger.info("No GCS_BUCKET configured; GCS features disabled");
}

// CORS headers helper
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "600",
};

async function downloadFromGCS(bucketName: string, objectName: string, destPath: string) {
  if (!storage) throw new Error("GCS client not initialized");
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);

  return new Promise<void>((resolve, reject: (err: Error) => void) => {
    const destStream = createWriteStream(destPath);
    file.createReadStream()
      .on("error", (err: Error) => reject(err))
      .on("end", () => resolve())
      .pipe(destStream);
  });
}

async function uploadToGCS(bucketName: string, localPath: string, destObjectName: string) {
  if (!storage) throw new Error("GCS client not initialized");
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, { destination: destObjectName });
}

async function getSignedUrl(bucketName: string, objectName: string) {
  if (!storage) throw new Error("GCS client not initialized");
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);
  const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + 60 * 60 * 1000 }); // 1 hour
  return url;
}

const PORT = Number(Bun.env.PORT || 8080);

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  maxRequestBodySize: 50 * 1024 * 1024,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // Basic request logging for diagnostics
    try {
      logger.info(`[req] ${req.method} ${pathname}`);
      logger.info(`  content-type: ${req.headers.get("content-type")}`);
      logger.info(`  content-length: ${req.headers.get("content-length")}`);
      // log headers but skip auth-sensitive ones
      for (const [k, v] of req.headers) {
        if (k.toLowerCase() === "authorization") continue;
        logger.debug(`  hdr: ${k}: ${v}`);
      }
    } catch (e) {
      // ignore logging errors
    }

    // Handle CORS preflight quickly
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: CORS_HEADERS });
    }

    if (pathname === "/api/convert") {
      let dir: string | null = null;
      try {
        // Validate method
        if (req.method !== "POST") {
          return Response.json({ message: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
        }

        const formdata = await req.formData();
        const filenameField = formdata.get("filename") as unknown as string;

        if (!filenameField || typeof filenameField !== "string") {
          return Response.json({ message: "You must provide a 'filename' form field pointing to the object in GCS" }, { status: 400, headers: CORS_HEADERS });
        }

        if (!storage || !GCS_BUCKET) {
          return Response.json({ message: "GCS is not configured on this server" }, { status: 500, headers: CORS_HEADERS });
        }

        // normalize to always look under the 'models/' prefix in the bucket
        const originalName = filenameField.startsWith("models/") ? filenameField : `models/${filenameField}`;
        const id = crypto.randomUUID();
        dir = `${FILES_FOLDER}/${id}`;
        await mkdir(dir, { recursive: true });

        // preserve the object's directory structure locally
        const parsed = parse(originalName); // { dir, base, name, ext }
        const objectDir = parsed.dir || ""; // e.g. 'models/some/path'
        const objectBase = parsed.base; // filename with ext
        const objectNameNoExt = parsed.name;
        const objectExt = parsed.ext;

        const localObjectDir = `${dir}/${objectDir}`;
        await mkdir(localObjectDir, { recursive: true });

        const destPath = `${localObjectDir}/${objectBase}`;
        logger.info(`Downloading ${originalName} from GCS bucket ${GCS_BUCKET} to ${destPath}`);
        await downloadFromGCS(GCS_BUCKET, originalName, destPath);

        logger.info(`Converting file ${originalName}...`);
        const inputPath = destPath;
        const convertedName = `${objectNameNoExt}.usdz`;
        const name = convertFile(inputPath);

        // upload the converted file back to the same object directory in GCS
        const outputPath = `${localObjectDir}/${convertedName}`;
        const destObjectName = `${objectDir}/${convertedName}`; // same directory as original
        logger.info(`Uploading converted file ${outputPath} to GCS bucket ${GCS_BUCKET} as ${destObjectName}`);
        await uploadToGCS(GCS_BUCKET, outputPath, destObjectName);
        const uploadedUrl = await getSignedUrl(GCS_BUCKET, destObjectName);

        return Response.json({ id, name, uploadedUrl, objectPath: destObjectName }, { status: 200, headers: CORS_HEADERS });
      } catch (err) {
        logger.error(String(err));
        return Response.json({ message: String(err) }, { status: 500, headers: CORS_HEADERS });
      } finally {
        if (dir) {
          try {
            await rm(dir, { recursive: true, force: true });
            logger.info(`Cleaned up temporary directory ${dir}`);
          } catch (cleanupErr) {
            logger.warn(`Failed to remove temp directory ${dir}: ${String(cleanupErr)}`);
          }
        }
      }
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
});

logger.info(`gltf2usdz is running on port ${PORT}`);

function convertFile(filepath: string) {
  const { ext, name } = parse(filepath);
  const output = filepath.replace(ext, ".usdz");

  const { stderr } = Bun.spawnSync([`usd_from_gltf`, filepath, output]);
  const stderrString = stderr.toString();
  if (stderrString) logger.warn(stderrString);

  const outputFile = Bun.file(output);
  if (!outputFile.exists()) {
    throw new Error("Failed to create USDZ file");
  }

  logger.info("File converted successfully");
  return `${name}.usdz`;
}