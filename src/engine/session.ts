import fs from 'node:fs';
import path from 'node:path';
import { SessionData } from '../types/index.js';

export function validateSessionData(data: any): asserts data is SessionData {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid session format: expected JSON object');
  }
  if (data.version !== 1) {
    throw new Error(`Unsupported session version: ${data.version}. Expected version 1`);
  }
  if (typeof data.url !== 'string') {
    throw new Error('Invalid session: missing "url" string');
  }
  if (!data.cookies || typeof data.cookies !== 'object') {
    throw new Error('Invalid session: missing or invalid "cookies" object');
  }
  if (!data.localStorage || typeof data.localStorage !== 'object') {
    throw new Error('Invalid session: missing or invalid "localStorage" object');
  }
  if (!data.sessionStorage || typeof data.sessionStorage !== 'object') {
    throw new Error('Invalid session: missing or invalid "sessionStorage" object');
  }
}

export function saveSessionToFile(filePath: string, session: SessionData): void {
  validateSessionData(session);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
}

export function loadSessionFromFile(filePath: string): SessionData {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse session JSON from ${filePath}: ${err.message}`);
  }
  validateSessionData(parsed);
  return parsed;
}

