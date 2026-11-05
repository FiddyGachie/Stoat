import { DbClient } from '../../db/connection.js';
import { sha256 } from '../../common/crypto.js';
import { NotFoundError } from '../../common/errors.js';

export interface ArtifactRecord {
  id: string;
  tenant_id: string;
  storage_key: string;
  content_hash: string;
  size_bytes: number;
  content_type: string;
  metadata: any;
  created_at: string;
}

export class ArtifactsService {
  constructor(private db: DbClient) {}

  async uploadArtifact(params: {
    tenantId: string;
    payload: any;
    contentType?: string;
  }): Promise<{ id: string; storage_key: string; content_hash: string; size_bytes: number }> {
    const rawContent = typeof params.payload === 'string' ? params.payload : JSON.stringify(params.payload);
    const contentHash = sha256(rawContent);
    const sizeBytes = Buffer.byteLength(rawContent, 'utf-8');
    const storageKey = `artifacts/${params.tenantId}/${contentHash}.json`;
    const contentType = params.contentType || 'application/json';

    const res = await this.db.query<{ id: string }>(
      `INSERT INTO artifacts (
        id, tenant_id, storage_key, content_hash, size_bytes, content_type, metadata
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6
      ) RETURNING id`,
      [
        params.tenantId,
        storageKey,
        contentHash,
        sizeBytes,
        contentType,
        JSON.stringify({ raw: rawContent, parsed: typeof params.payload === 'object' ? params.payload : null }),
      ]
    );

    return {
      id: res.rows[0].id,
      storage_key: storageKey,
      content_hash: contentHash,
      size_bytes: sizeBytes,
    };
  }

  async getArtifact(tenantId: string, artifactId: string): Promise<ArtifactRecord> {
    const res = await this.db.query(
      `SELECT id, tenant_id, storage_key, content_hash, size_bytes, content_type, metadata, created_at
       FROM artifacts
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, artifactId]
    );

    if (res.rows.length === 0) {
      throw new NotFoundError('Artifact', artifactId);
    }

    const row = res.rows[0];
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }
}
