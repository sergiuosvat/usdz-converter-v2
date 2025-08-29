import { mkdir } from "node:fs/promises";
import { parse } from "path";
import winston from "winston";

const FILES_FOLDER = "/usr/app/gltf2usdz/files";
const LOGS_FOLDER = "/usr/app/gltf2usdz/logs";
const FRONTEND_FOLDER = "../client/dist";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      (info) => `[${info.timestamp}] ${info.level}: ${info.message}`,
    ),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      // 20 megabytes
      maxsize: 20_000_000,
      maxFiles: 5,
      filename: `${LOGS_FOLDER}/app.log`,
      format: winston.format.timestamp(),
    }),
  ],
});



mkdir(FILES_FOLDER, { recursive: true });


Bun.serve({
  port: 4000,
  maxRequestBodySize: 1024 * 1024 * 50, // 50MB
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);

    if (pathname === "/api/convert") {
      try {
        const formdata = await req.formData();
        const file = formdata.get("file") as unknown as File;

        logger.info(`Converting file ${file.name}...`);

        if (
          !file ||
          !(file instanceof File) ||
          !(file.name.endsWith(".gltf") || file.name.endsWith(".glb"))
        ) {
          throw new Error("You must upload a glb/gltf file.");
        }

        const id = crypto.randomUUID();
        const filename = `${FILES_FOLDER}/${id}/${file.name}`;

        await Bun.write(filename, file);

        const name = convertFile(filename);

        return Response.json({ id, name });
      } catch (error) {
        logger.error(error);
        return Response.json({ message: String(error) }, { status: 500 });
      }
    }

    if (pathname === "/api/download") {
      try {
        if (!searchParams.has("id") || !searchParams.has("name")) {
          return new Response("Bad request", { status: 400 });
        }

        const file = Bun.file(
          `${FILES_FOLDER}/${searchParams.get("id")}/${searchParams.get("name")}`,
        );

        if (!(await file.exists())) {
          throw new Error();
        }

        return new Response(file);
      } catch (error) {
        const message =
          "Failed to download the file.";
        logger.error(message);
        return Response.json({ message }, { status: 500 });
      }
    }

    if (pathname === "/") {
      return new Response(Bun.file(`${FRONTEND_FOLDER}/index.html`));
    }

    try {
      const file = Bun.file(FRONTEND_FOLDER + pathname);

      if (!(await file.exists())) {
        throw new Error();
      }

      return new Response(file);
    } catch (error) {
      return new Response("Not Found", { status: 404 });
    }
  },
});

logger.info("gltf2usdz is running on port 4000");

function convertFile(filepath: string) {
  const { ext, name } = parse(filepath);

  const output = filepath.replace(ext, ".usdz");

  const { stderr } = Bun.spawnSync([`usd_from_gltf`, filepath, output]);

  const stderrString = stderr.toString();
  
  if (stderrString) {
    logger.warn(stderrString);
  }

  const outputFile = Bun.file(output);
  if (!outputFile.exists()) {
    throw new Error("Failed to create USDZ file");
  }

  logger.info("File converted successfully");

  return `${name}.usdz`;
}


