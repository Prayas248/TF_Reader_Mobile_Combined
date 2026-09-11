// src/adapters/PartialApiAdapter.ts
// A DataSource for the in-between state where only some real endpoints exist.
//
// Institutions, the home catalogue, a shelf, a publication and items:batch all
// now route to the real backend — wokay's contract confirms those seven paths
// as FROZEN, and ApiAdapter sends the appToken bearer the four catalogue-side
// ones require. Only the public feed and public publication still come from
// fixtures, since PartialApiAdapter predates this and nobody's flipped them
// yet — swap a method over to `this.api` as its real endpoint gets verified.
// Search (institution-scoped and public) has no ApiAdapter method at all yet.
import type { BookId } from '@/shared/types/primitives';
import type { BatchItemsResult, Catalogue, Publication, Shelf, WorkFeed } from '@model/types';
import type { Institution } from '@model/institution';
import type { DataSource, InstitutionQueryParams } from '@adapters/InstitutionSource';
import type { ShelfQuery } from '@adapters/CatalogueSource';
import { ApiAdapter } from '@adapters/ApiAdapter';
import { MockAdapter, type MockAdapterOptions } from '@adapters/MockAdapter';

export class PartialApiAdapter implements DataSource {
  private readonly api: ApiAdapter;
  private readonly mock: MockAdapter;

  constructor(
    baseUrl: string,
    mockOptions?: MockAdapterOptions,
    getToken?: () => Promise<string | undefined>,
  ) {
    this.api = new ApiAdapter({ baseUrl, getToken });
    this.mock = new MockAdapter(mockOptions);
  }

  getInstitutions(params?: InstitutionQueryParams): Promise<Institution[]> {
    return this.api.getInstitutions(params);
  }

  getInstitution(institutionId: string): Promise<Institution> {
    return this.api.getInstitution(institutionId);
  }

  getHomeCatalogue(institutionId: string): Promise<Catalogue> {
    return this.api.getHomeCatalogue(institutionId);
  }

  getShelf(
    institutionId: string,
    shelfId: string,
    page?: number,
    query?: ShelfQuery,
  ): Promise<Shelf> {
    return this.api.getShelf(institutionId, shelfId, page, query);
  }

  getPublication(institutionId: string, bookId: BookId): Promise<Publication> {
    return this.api.getPublication(institutionId, bookId);
  }

  getPublicFeed(page?: number): Promise<Shelf> {
    return this.api.getPublicFeed(page);
  }

  getPublicPublication(bookId: BookId): Promise<Publication> {
    return this.api.getPublicPublication(bookId);
  }

  getItemsBatch(ids: BookId[]): Promise<BatchItemsResult> {
    return this.api.getItemsBatch(ids);
  }

  getWork(institutionId: string, workId: string): Promise<WorkFeed> {
    return this.api.getWork(institutionId, workId);
  }
}
