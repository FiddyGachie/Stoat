import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { initDb } from "../db/connection.js";

function stripFunctionPrefix(url: string): string {
  const withoutPrefix = url.replace(/^\/api(?=\/|\?|$)/, "");
  return withoutPrefix.startsWith("?") ? `/${withoutPrefix}` : withoutPrefix || "/";
}

function initializeDatabase(req: Request, res: Response, next: NextFunction): void {
  req.url = stripFunctionPrefix(req.url);
  const requestPath = req.url.split("?")[0];
  const isHealthCheck = req.method === "GET" && ["/health", "/v1/health"].includes(requestPath);

  if (isHealthCheck) {
    next();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(500).json({
      error: {
        code: "DATABASE_URL_MISSING",
        message: "DATABASE_URL must be configured for the Vercel API.",
        correlation_id: randomUUID(),
      },
    });
    return;
  }

  try {
    initDb({ databaseUrl });
    next();
  } catch {
    res.status(500).json({
      error: {
        code: "DATABASE_CONFIGURATION_INVALID",
        message: "The configured DATABASE_URL could not initialize the database client.",
        correlation_id: randomUUID(),
      },
    });
  }
}

export function createVercelApp(app: Express = createApp()): Express {
  const functionApp = express();
  functionApp.use(initializeDatabase);
  functionApp.use(app);
  return functionApp;
}
