import fs from 'node:fs';
import path from 'node:path';
import { FlightSession, FlightStep, FlightAction, FlightDiffSummary } from './types.js';
import { generateReplayHtml } from './html-template.js';

export class FlightRecorder {
  private currentSession: FlightSession | null = null;
  private traceDir: string;
  private stepStartTime: number = 0;

  constructor(options: { traceDir?: string } = {}) {
    this.traceDir = options.traceDir || path.join(process.cwd(), '.orbis', 'traces');
  }

  public startSession(initialUrl: string = 'about:blank', name?: string): FlightSession {
    const id = `flight-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.currentSession = {
      id,
      name,
      startedAt: new Date().toISOString(),
      initialUrl,
      steps: []
    };
    this.stepStartTime = Date.now();
    return this.currentSession;
  }

  public recordStep(details: {
    url: string;
    title: string;
    action?: FlightAction;
    actionMapText?: string;
    markdownPreview?: string;
    diffSummary?: FlightDiffSummary;
    consoleLogs?: Array<{ type: string; text: string }>;
  }): FlightStep {
    if (!this.currentSession) {
      this.startSession(details.url);
    }

    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.stepStartTime);
    this.stepStartTime = now;

    const step: FlightStep = {
      index: this.currentSession!.steps.length,
      timestamp: now,
      elapsedMs,
      url: details.url,
      title: details.title,
      action: details.action,
      actionMapText: details.actionMapText,
      markdownPreview: details.markdownPreview,
      diffSummary: details.diffSummary,
      consoleLogs: details.consoleLogs
    };

    this.currentSession!.steps.push(step);
    return step;
  }

  public endSession(): FlightSession {
    if (!this.currentSession) {
      throw new Error('No active flight recording session to end');
    }

    this.currentSession.endedAt = new Date().toISOString();
    const start = new Date(this.currentSession.startedAt).getTime();
    this.currentSession.totalDurationMs = Date.now() - start;

    // Auto-save JSON and HTML replay file
    this.save();

    const session = this.currentSession;
    this.currentSession = null;
    return session;
  }

  public get active(): boolean {
    return this.currentSession !== null;
  }

  public get session(): FlightSession | null {
    return this.currentSession;
  }

  public save(customPath?: string): { jsonPath: string; htmlPath: string } {
    if (!this.currentSession) {
      throw new Error('No session to save');
    }

    if (!fs.existsSync(this.traceDir)) {
      fs.mkdirSync(this.traceDir, { recursive: true });
    }

    const baseName = customPath || path.join(this.traceDir, `${this.currentSession.id}`);
    const jsonPath = baseName.endsWith('.json') ? baseName : `${baseName}.json`;
    const htmlPath = baseName.endsWith('.html') ? baseName : `${baseName}.html`;

    fs.writeFileSync(jsonPath, JSON.stringify(this.currentSession, null, 2), 'utf8');
    fs.writeFileSync(htmlPath, generateReplayHtml(this.currentSession), 'utf8');

    return { jsonPath, htmlPath };
  }
}
