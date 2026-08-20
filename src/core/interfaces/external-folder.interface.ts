import { ExternalSource } from '../enums/external-source.enum';

export interface ExternalFolder {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: {
    id: string;
    path: string;
    name?: string;
  };
  childCount?: number;
  source: ExternalSource;
}
