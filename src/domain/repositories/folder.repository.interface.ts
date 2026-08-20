import { IFolder } from "../../db/models/folder.model";

export interface IFolderRepository {
  findById(id: string): Promise<IFolder | null>;
  create(folder: Partial<IFolder>): Promise<IFolder>;
  update(id: string, folder: Partial<IFolder>): Promise<IFolder | null>;
  delete(id: string): Promise<boolean>;
  findByExternalId(externalId: string): Promise<IFolder | null>;
  findAll(filter?: any): Promise<IFolder[]>;
}
