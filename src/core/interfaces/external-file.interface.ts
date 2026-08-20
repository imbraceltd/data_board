import { ExternalSource } from '../enums/external-source.enum';

export interface ExternalFile {
  id: string;
  name: string;
  webUrl?: string;
  size: number;
  mimeType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: {
    id: string;
    path: string;
    name?: string;
  };
  downloadUrl?: string;
  source: ExternalSource;
}
