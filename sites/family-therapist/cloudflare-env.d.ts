declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    THERAPIST_API_BASE_URL?: string;
    THERAPIST_API_KEY?: string;
    THERAPIST_MODEL?: string;
    THERAPIST_MEMBER_SEED?: string;
  }
}
