// server/index.ts
import { Storage } from "@google-cloud/storage";
import { createWriteStream } from "fs";
import { mkdir } from "node:fs/promises";
import { parse } from "path";
import winston from "winston";

const FILES_FOLDER = process.env.FILES_FOLDER || "/tmp/gltf2usdz/files";
const LOGS_FOLDER  = process.env.LOGS_FOLDER  || "/tmp/gltf2usdz/logs";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => `[${info.timestamp}] ${info.level}: ${info.message}`),
  ),
  transports: [
    new winston.transports.Console(),
    // File transport now points to /tmp
    new winston.transports.File({
      maxsize: 20_000_000,
      maxFiles: 5,
      filename: `${LOGS_FOLDER}/app.log`,
      format: winston.format.timestamp(),
    }),
  ],
});

await mkdir(FILES_FOLDER, { recursive: true });
await mkdir(LOGS_FOLDER,  { recursive: true });

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

    if (pathname === "/healthz") return new Response("ok");

    if (pathname === "/api/convert") {
      try {
        const formdata = await req.formData();
        const filenameField = formdata.get("filename") as unknown as string;

        if (!filenameField || typeof filenameField !== "string") {
          return Response.json({ message: "You must provide a 'filename' form field pointing to the object in GCS" }, { status: 400 });
        }

        if (!storage || !GCS_BUCKET) {
          return Response.json({ message: "GCS is not configured on this server" }, { status: 500 });
        }

  // normalize to always look under the 'models/' prefix in the bucket
  const originalName = filenameField.startsWith("models/") ? filenameField : `models/${filenameField}`;
        const id = crypto.randomUUID();
        const dir = `${FILES_FOLDER}/${id}`;
        await mkdir(dir, { recursive: true });

        const destPath = `${dir}/${originalName}`;
        logger.info(`Downloading ${originalName} from GCS bucket ${GCS_BUCKET} to ${destPath}`);
        await downloadFromGCS(GCS_BUCKET, originalName, destPath);

        logger.info(`Converting file ${originalName}...`);
        const inputPath = destPath;
        const name = convertFile(inputPath);

        const outputPath = `${dir}/${name}`;
  const destObjectName = `models/${id}/${name}`; // store under models/<id>/<name> to avoid collisions
        logger.info(`Uploading converted file ${outputPath} to GCS bucket ${GCS_BUCKET} as ${destObjectName}`);
        await uploadToGCS(GCS_BUCKET, outputPath, destObjectName);
        const uploadedUrl = await getSignedUrl(GCS_BUCKET, destObjectName);

        return Response.json({ id, name, uploadedUrl });
      } catch (err) {
        logger.error(String(err));
        return Response.json({ message: String(err) }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
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
