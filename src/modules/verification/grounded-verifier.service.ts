import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbClient } from '../../db/connection.js';

export interface CodeReviewFinding {
  file: string;
  line_start: number;
  line_end: number;
  snippet: string;
  rule_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title?: string;
  description?: string;
}

export interface VerificationCheckResult {
  check: string;
  passed: boolean;
  message?: string;
  finding_index?: number;
}

export interface VerificationOutcome {
  verdict: 'verified' | 'rejected' | 'needs_review';
  checks: VerificationCheckResult[];
  reasons: string[];
  verifier_version: string;
}

export class GroundedVerifierService {
  private fixtureRoot: string;

  constructor(private db: DbClient, fixtureDir?: string) {
    if (fixtureDir) {
      this.fixtureRoot = fixtureDir;
    } else {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      this.fixtureRoot = path.resolve(currentDir, '../../../fixtures/repo-fixture');
    }
  }

  async verifyReviewDelivery(params: {
    tenantId: string;
    deliveryId: string;
    findings: CodeReviewFinding[];
    verificationProfile: {
      allowed_rules: string[];
      allowed_severities?: string[];
      max_findings?: number;
      min_coverage_pct?: number;
      version?: string;
    };
  }): Promise<VerificationOutcome> {
    const checks: VerificationCheckResult[] = [];
    const reasons: string[] = [];
    const verifierVersion = params.verificationProfile.version || '1.0.0';

    // 1. Load manifest
    const manifestPath = path.join(this.fixtureRoot, 'manifest.json');
    let manifest: any = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }

    const allowedRules = new Set(params.verificationProfile.allowed_rules || []);
    const allowedSeverities = new Set(params.verificationProfile.allowed_severities || ['low', 'medium', 'high', 'critical']);
    const maxFindings = params.verificationProfile.max_findings || 10;

    let hardFailure = false;
    let softFailure = false;

    // Check: Findings payload format
    if (!Array.isArray(params.findings)) {
      checks.push({ check: 'schema_valid', passed: false, message: 'Findings must be an array' });
      reasons.push('INVALID_PAYLOAD_STRUCTURE');
      hardFailure = true;
    } else {
      checks.push({ check: 'schema_valid', passed: true });

      // Check (g): Max findings count
      if (params.findings.length > maxFindings) {
        checks.push({
          check: 'max_findings_limit',
          passed: false,
          message: `Findings count ${params.findings.length} exceeds agreement limit ${maxFindings}`,
        });
        reasons.push('EXCESS_FINDINGS_COUNT');
        softFailure = true;
      } else {
        checks.push({ check: 'max_findings_limit', passed: true });
      }

      // Track duplicate findings
      const seenFindings = new Set<string>();

      for (let idx = 0; idx < params.findings.length; idx++) {
        const finding = params.findings[idx];

        // (a) file_exists
        const fileManifest = manifest?.files?.[finding.file];
        if (!fileManifest) {
          checks.push({
            check: 'file_exists',
            passed: false,
            message: `File '${finding.file}' does not exist in repository manifest.`,
            finding_index: idx,
          });
          reasons.push(`UNGROUNDED_FILE: ${finding.file}`);
          hardFailure = true;
          continue;
        } else {
          checks.push({ check: 'file_exists', passed: true, finding_index: idx });
        }

        // (b) valid_line_range
        if (
          finding.line_start <= 0 ||
          finding.line_end <= 0 ||
          finding.line_start > finding.line_end ||
          finding.line_end > fileManifest.lines
        ) {
          checks.push({
            check: 'valid_line_range',
            passed: false,
            message: `Invalid line range ${finding.line_start}-${finding.line_end} for file '${finding.file}' (${fileManifest.lines} lines).`,
            finding_index: idx,
          });
          reasons.push(`OUT_OF_RANGE_LINES: ${finding.file}:${finding.line_start}-${finding.line_end}`);
          hardFailure = true;
          continue;
        } else {
          checks.push({ check: 'valid_line_range', passed: true, finding_index: idx });
        }

        // (c) snippet_match
        const fullFilePath = path.join(this.fixtureRoot, finding.file);
        if (fs.existsSync(fullFilePath)) {
          const fileLines = fs.readFileSync(fullFilePath, 'utf-8').split(/\r?\n/);
          const actualLines = fileLines.slice(finding.line_start - 1, finding.line_end);
          const actualSnippetNormalized = actualLines.map((l) => l.trim()).join('\n').trim();
          const expectedSnippetNormalized = finding.snippet
            .split(/\r?\n/)
            .map((l) => l.trim())
            .join('\n')
            .trim();

          if (actualSnippetNormalized !== expectedSnippetNormalized) {
            checks.push({
              check: 'snippet_match',
              passed: false,
              message: `Snippet mismatch in '${finding.file}' at lines ${finding.line_start}-${finding.line_end}.`,
              finding_index: idx,
            });
            reasons.push(`SNIPPET_MISMATCH: ${finding.file}:${finding.line_start}`);
            hardFailure = true;
          } else {
            checks.push({ check: 'snippet_match', passed: true, finding_index: idx });
          }
        }

        // (d) rule_allowlisted
        if (!allowedRules.has(finding.rule_id)) {
          checks.push({
            check: 'rule_allowlisted',
            passed: false,
            message: `Rule ID '${finding.rule_id}' is not in service allowlist.`,
            finding_index: idx,
          });
          reasons.push(`FORBIDDEN_RULE: ${finding.rule_id}`);
          hardFailure = true;
        } else {
          checks.push({ check: 'rule_allowlisted', passed: true, finding_index: idx });
        }

        // (e) severity_valid
        if (!allowedSeverities.has(finding.severity)) {
          checks.push({
            check: 'severity_valid',
            passed: false,
            message: `Severity '${finding.severity}' is not valid.`,
            finding_index: idx,
          });
          reasons.push(`INVALID_SEVERITY: ${finding.severity}`);
          hardFailure = true;
        } else {
          checks.push({ check: 'severity_valid', passed: true, finding_index: idx });
        }

        // (f) no_duplicates
        const key = `${finding.file}:${finding.line_start}:${finding.line_end}:${finding.rule_id}`;
        if (seenFindings.has(key)) {
          checks.push({
            check: 'no_duplicates',
            passed: false,
            message: `Duplicate finding encountered: ${key}`,
            finding_index: idx,
          });
          reasons.push(`DUPLICATE_FINDING: ${key}`);
          hardFailure = true;
        } else {
          seenFindings.add(key);
          checks.push({ check: 'no_duplicates', passed: true, finding_index: idx });
        }
      }
    }

    let verdict: 'verified' | 'rejected' | 'needs_review' = 'verified';
    if (hardFailure) {
      verdict = 'rejected';
    } else if (softFailure) {
      verdict = 'needs_review';
    }

    // Persist verification
    await this.db.query(
      `INSERT INTO verifications (
        id, tenant_id, delivery_id, verdict, checks, verifier_version, reasons, verified_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, now()
      )`,
      [
        params.tenantId,
        params.deliveryId,
        verdict,
        JSON.stringify(checks),
        verifierVersion,
        JSON.stringify(reasons),
      ]
    );

    return {
      verdict,
      checks,
      reasons,
      verifier_version: verifierVersion,
    };
  }
}
