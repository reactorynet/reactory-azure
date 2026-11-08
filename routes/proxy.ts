import express, { Request, Response } from 'express';
import logger from '@reactory/server-core/logging';
import { extractStatusCode } from '../utils/graph-error';

/**
 * Binary proxy for OneDrive content, mounted under `/azure`.
 *
 *   GET /azure/files/:itemId             → the file's bytes
 *   GET /azure/files/:itemId/thumbnail   → a thumbnail rendition
 *
 * Why a proxy at all: Graph answers both endpoints with a 302 to a
 * **pre-authenticated** storage URL. Returning that URL to a browser would turn
 * a scoped, revocable Microsoft grant into an anonymous download handle that
 * outlives the session. So the URL never leaves the server: the service follows
 * the redirect without its `Authorization` header and this router pipes the
 * stream, setting `Content-Type` and `Content-Disposition` itself.
 *
 * These handlers resolve `azure.AzureDriveService@1.0.0` from the request
 * context, exactly like `routes/auth.ts`. No token, no storage URL and no Graph
 * payload is ever echoed back.
 */

const router = express.Router();

/** The service FQN, so the string lives in one place. */
const DRIVE_SERVICE_ID = 'azure.AzureDriveService@1.0.0';

/** Graph error codes that map onto a specific HTTP status. */
const STATUS_BY_CODE: Record<string, number> = {
  itemNotFound: 404,
  accessDenied: 403,
  notAllowed: 403,
  InvalidAuthenticationToken: 401,
  LegacyTokenExpired: 401,
  NotConnected: 401,
  InvalidDriveItemId: 400,
  InvalidDrivePath: 400,
};

function getContext(req: Request): any {
  return (req as any).context;
}

/** Resolve the drive service, or write the 503/401 response and return `undefined`. */
function getDriveService(req: Request, res: Response): any {
  const context = getContext(req);

  if (!context?.user) {
    res.status(401).json({ error: 'Authentication required' });
    return undefined;
  }

  let driveService: any;

  try {
    driveService = context.getService?.(DRIVE_SERVICE_ID);
  } catch (error: any) {
    // A container failure must not become an unhandled rejection: Express 4 does
    // not catch a rejected async handler, so the client would hang.
    logger.error(`Azure drive proxy: the service container failed (${error?.message})`);
    driveService = undefined;
  }

  if (!driveService) {
    res.status(503).json({ error: 'Azure Drive Service not available' });
    return undefined;
  }

  return driveService;
}

/**
 * Build a `Content-Disposition` that is safe for a header.
 *
 * The ASCII `filename` is stripped of CR/LF/quotes (a header-injection guard) and
 * a non-ASCII name is additionally carried in the RFC 5987 `filename*` form so
 * the browser still shows the real name.
 */
export function buildContentDisposition(
  fileName: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const original = String(fileName || '').trim() || 'download';

  const ascii = original
    .replace(/[\r\n"]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '_') || 'download';

  const encoded = encodeURIComponent(original)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Translate a service failure into a status and a minimal JSON body. */
function respondWithError(res: Response, error: any, operation: string): void {
  const explicit = extractStatusCode(error);
  const mapped = STATUS_BY_CODE[String(error?.code)] || undefined;
  const status = explicit || mapped || 500;

  logger.error(`Azure drive proxy: ${operation} failed (${status} ${error?.code || error?.message})`);

  if (res.headersSent) {
    // The stream already started; the only safe signal left is a broken response.
    res.destroy(error);
    return;
  }

  res.status(status).json({
    error: error?.message || 'The drive request failed',
    code: error?.code || 'GraphRequestFailed',
  });
}

/**
 * Pipe a download to the client.
 *
 * `Content-Length` is only forwarded when Graph supplied one - a chunked response
 * must not claim a length it cannot honour. `Cache-Control: private, no-store`
 * keeps a per-user document out of shared caches.
 */
function pipeDownload(
  res: Response,
  download: { stream: any; contentType?: string; contentLength?: number },
  options: { contentType?: string; fileName: string; disposition: 'attachment' | 'inline'; cacheControl: string },
): void {
  res.setHeader('Content-Type', options.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', buildContentDisposition(options.fileName, options.disposition));
  res.setHeader('Cache-Control', options.cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (typeof download.contentLength === 'number' && download.contentLength >= 0) {
    res.setHeader('Content-Length', String(download.contentLength));
  }

  const { stream } = download;

  stream.on('error', (error: Error) => {
    logger.error(`Azure drive proxy: the content stream failed (${error?.message})`);

    if (!res.headersSent) {
      // A download that failed before its first byte must not inherit the
      // Content-Type / Content-Disposition the stream would have used, or the
      // JSON error body would be served as an octet-stream attachment.
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(502).json({ error: 'The drive content stream failed', code: 'GraphRequestFailed' });
      return;
    }

    res.destroy(error);
  });

  // A client that hangs up must not leave the Graph request open.
  res.on('close', () => {
    if (stream && typeof stream.destroy === 'function' && !stream.destroyed) {
      stream.destroy();
    }
  });

  stream.pipe(res);
}

/**
 * GET /azure/files/:itemId[?disposition=inline]
 *
 * The item metadata read supplies the file name and MIME type for the headers;
 * the service read supplies the bytes.
 */
router.get('/files/:itemId', async (req: Request, res: Response) => {
  const driveService = getDriveService(req, res);
  if (!driveService) return undefined;

  const userId = String((req as any).context.user._id);
  const itemId = String(req.params.itemId || '');
  const disposition = String(req.query.disposition || '').toLowerCase() === 'inline' ? 'inline' : 'attachment';

  try {
    const item = await driveService.getItem(userId, itemId);
    const download = await driveService.downloadItem(userId, itemId, {
      fileName: item?.name,
    });

    pipeDownload(res, download, {
      contentType: download.contentType || item?.file?.mimeType,
      fileName: download.fileName || item?.name || 'download',
      disposition,
      cacheControl: 'private, no-store',
    });

    return undefined;
  } catch (error: any) {
    respondWithError(res, error, 'GET /azure/files/:itemId');
    return undefined;
  }
});

/**
 * GET /azure/files/:itemId/thumbnail?size=small|medium|large
 *
 * Thumbnails are cacheable for a short window because they are keyed by item id
 * and rendition - but never `public`, because the response is user-scoped.
 */
router.get('/files/:itemId/thumbnail', async (req: Request, res: Response) => {
  const driveService = getDriveService(req, res);
  if (!driveService) return undefined;

  const userId = String((req as any).context.user._id);
  const itemId = String(req.params.itemId || '');
  const requested = String(req.query.size || 'large').toLowerCase();
  const size = ['small', 'medium', 'large'].includes(requested) ? requested : 'large';

  try {
    const thumbnail = await driveService.getThumbnail(userId, itemId, { size });

    pipeDownload(res, thumbnail, {
      contentType: thumbnail.contentType || 'image/jpeg',
      fileName: `${itemId}-${size}.jpg`,
      disposition: 'inline',
      cacheControl: 'private, max-age=300',
    });

    return undefined;
  } catch (error: any) {
    respondWithError(res, error, 'GET /azure/files/:itemId/thumbnail');
    return undefined;
  }
});

export default router;
