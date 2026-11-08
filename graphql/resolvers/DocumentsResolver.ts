import { roles } from '@reactory/server-core/authentication/decorators';
import { resolver, query, mutation, property } from '@reactory/server-core/models/graphql/decorators/resolver';
import {
  DOCX_EXTENSION,
  DOCX_MIME_TYPE,
  PDF_CONVERSION_MAX_BYTES,
  type IDocumentMetadata,
} from '../../types/document.types';
import { DOCUMENT_ERROR_CODES } from '../../services/AzureDocumentService';
import { apiError } from '../../utils/graph-error';

/**
 * The slice of the request context this resolver actually uses.
 *
 * Declared as a local **interface** rather than annotated
 * `Reactory.Server.IReactoryContext` for the same reason as `DriveResolver`: it
 * documents the exact surface a resolver may touch, and it keeps
 * `emitDecoratorMetadata` from rewriting each decorated method's
 * `design:paramtypes` into dead runtime code that coverage tooling then reports
 * as unreachable branches.
 */
interface DocumentsResolverContext {
  /** The authenticated user; `_id` is the id every service method takes. */
  user: { _id: any };
  /** Resolve a service by FQN, e.g. `azure.AzureDocumentService@1.0.0`. */
  getService(id: string): any;
}

/**
 * GraphQL surface for Word documents.
 *
 * Every field is a thin adapter over `azure.AzureDocumentService@1.0.0`: the
 * service owns the Graph contract (encoding, the 2 MB conversion ceiling, the
 * redirect discipline, error translation) and this class owns argument mapping,
 * the base64 boundary and the derived fields an SDL makes awkward.
 *
 * There is deliberately **no** field that edits a document body. Microsoft
 * exposes no server-side Word body-editing API - the Office JS API requires an
 * Office Add-in running inside the document, and there is no Graph equivalent of
 * Google Docs `batchUpdate` (audit §7 G1). `azureReplaceDocument` replaces the
 * whole file; `azureCreateDocumentFromTemplate` substitutes literal text in a
 * copy. Nothing pretends to be more than that.
 */
@resolver
class DocumentsResolver {
  resolver: any;

  private getService(context: DocumentsResolverContext): any {
    const documentService = context.getService('azure.AzureDocumentService@1.0.0') as any;

    if (!documentService) throw new Error('Azure Document Service not available');

    return documentService;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** `GET /me/drive/items/{id}` projected onto the document fields. */
  @roles(['USER'], 'args.context')
  @query('azureDocumentMetadata')
  async getDocumentMetadata(
    _obj: any,
    params: { itemId: string; driveId?: string },
    context: DocumentsResolverContext,
  ) {
    return this.getService(context).getDocumentMetadata(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );
  }

  /**
   * Extract a document's plain text.
   *
   * A non-`.docx` item fails with `InvalidDocumentFormat` from the service rather
   * than being streamed back as text.
   */
  @roles(['USER'], 'args.context')
  @query('azureDocumentText')
  async getDocumentText(
    _obj: any,
    params: { itemId: string; driveId?: string },
    context: DocumentsResolverContext,
  ) {
    return this.getService(context).getDocumentText(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );
  }

  /**
   * Convert a Word document to PDF.
   *
   * The service returns a stream; GraphQL has no binary scalar, so the stream is
   * buffered into base64 here. That is only safe because the service has already
   * refused anything above Graph's 2 MB conversion ceiling *before* issuing a
   * request - and the buffer is bounded again below so a misbehaving transport
   * cannot exceed it.
   */
  @roles(['USER'], 'args.context')
  @query('azureDocumentPdf')
  async convertToPdf(
    _obj: any,
    params: { itemId: string; driveId?: string },
    context: DocumentsResolverContext,
  ) {
    const conversion = await this.getService(context).convertToPdf(
      String(context.user._id),
      params.itemId,
      { driveId: params.driveId },
    );

    const bytes = await this.collectBounded(
      conversion.stream,
      PDF_CONVERSION_MAX_BYTES,
      params.itemId,
    );

    return {
      itemId: conversion.itemId,
      format: 'PDF',
      contentType: conversion.contentType || 'application/pdf',
      contentLength: bytes.length,
      contentBase64: bytes.toString('base64'),
    };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Copy a template and substitute literal token text.
   *
   * Reported as `TEXT_SUBSTITUTION` with an explicit note: the copy is a
   * byte-for-byte template with tokens replaced, not a structurally edited
   * document. Body editing is not available from the server (audit §7 G1).
   */
  @roles(['USER'], 'args.context')
  @mutation('azureCreateDocumentFromTemplate')
  async createFromTemplate(
    _obj: any,
    params: {
      templateItemId: string;
      name: string;
      replacements: Array<{ token: string; value: string }>;
      driveId?: string;
    },
    context: DocumentsResolverContext,
  ) {
    const replacements: Record<string, string> = {};

    for (const replacement of params.replacements || []) {
      if (!replacement || !replacement.token) {
        throw apiError(
          DOCUMENT_ERROR_CODES.INVALID_TEMPLATE_REPLACEMENT,
          'azureCreateDocumentFromTemplate requires a token for every replacement',
          { operation: 'resolver.azureCreateDocumentFromTemplate' },
        );
      }

      replacements[replacement.token] = String(replacement.value ?? '');
    }

    const result = await this.getService(context).createFromTemplate(
      String(context.user._id),
      params.templateItemId,
      params.name,
      replacements,
      { driveId: params.driveId },
    );

    return {
      ...result,
      note:
        'Text substitution only: literal tokens were replaced in a copy of the template. '
        + 'Microsoft Graph exposes no server-side Word body-editing API, so no paragraph, table, '
        + 'image or field was created, removed or reordered.',
    };
  }

  /** Replace a document's entire file contents with a supplied `.docx`. */
  @roles(['USER'], 'args.context')
  @mutation('azureReplaceDocument')
  async replaceDocument(
    _obj: any,
    params: { itemId: string; contentBase64: string; driveId?: string },
    context: DocumentsResolverContext,
  ) {
    const content = Buffer.from(String(params.contentBase64 || ''), 'base64');

    return this.getService(context).replaceDocument(
      String(context.user._id),
      params.itemId,
      content,
      { driveId: params.driveId },
    );
  }

  // ---------------------------------------------------------------------------
  // Derived fields
  // ---------------------------------------------------------------------------

  /** The lower-cased extension, or null when the name has none. */
  @property('AzureDocumentMetadata', 'extension')
  resolveExtension(metadata: IDocumentMetadata): string | null {
    const match = /(\.[A-Za-z0-9]+)$/.exec(String(metadata?.name ?? '').trim());

    return match ? match[1].toLowerCase() : null;
  }

  /** True for OOXML `.docx` - the only format this module reads as text. */
  @property('AzureDocumentMetadata', 'isWordDocument')
  resolveIsWordDocument(metadata: IDocumentMetadata): boolean {
    const extension = /(\.[A-Za-z0-9]+)$/.exec(String(metadata?.name ?? '').trim());

    return (extension?.[1] || '').toLowerCase() === DOCX_EXTENSION
      || String(metadata?.mimeType ?? '').toLowerCase() === DOCX_MIME_TYPE;
  }

  /**
   * Whether `azureDocumentPdf` can convert this item.
   *
   * Mirrors the service's pre-flight exactly - a Word document at or below the
   * 2 MB ceiling - so a client can disable a button for the same reason the
   * server would refuse the call.
   */
  @property('AzureDocumentMetadata', 'convertibleToPdf')
  resolveConvertibleToPdf(metadata: IDocumentMetadata): boolean {
    const extension = /(\.[A-Za-z0-9]+)$/.exec(String(metadata?.name ?? '').trim());
    const isWord = (extension?.[1] || '').toLowerCase() === DOCX_EXTENSION
      || String(metadata?.mimeType ?? '').toLowerCase() === DOCX_MIME_TYPE;
    const size = metadata?.size;

    return isWord
      && typeof size === 'number'
      && Number.isFinite(size)
      && size > 0
      && size <= PDF_CONVERSION_MAX_BYTES;
  }

  /** The conversion ceiling, so a client never hard-codes 2 MB on its own. */
  @property('AzureDocumentMetadata', 'pdfConversionLimitBytes')
  resolvePdfConversionLimit(): number {
    return PDF_CONVERSION_MAX_BYTES;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Read a stream to a Buffer, refusing to exceed `limit` bytes. */
  private async collectBounded(stream: any, limit: number, itemId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
      chunks.push(buffer);
      size += buffer.length;

      if (size > limit) {
        (stream as any)?.destroy?.();

        throw apiError(
          DOCUMENT_ERROR_CODES.FILE_TOO_LARGE_FOR_CONVERSION,
          `The PDF conversion of "${itemId}" exceeded the ${limit}-byte conversion ceiling while `
            + 'streaming; refusing to return a truncated document.',
          { itemId, size, limit },
        );
      }
    }

    if (!size) {
      throw apiError(
        DOCUMENT_ERROR_CODES.DOCUMENT_CONVERSION_FAILED,
        `The PDF conversion of "${itemId}" produced no bytes`,
        { itemId },
      );
    }

    return Buffer.concat(chunks);
  }
}

export default DocumentsResolver;
