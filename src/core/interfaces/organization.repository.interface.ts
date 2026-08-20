import { IOrganization } from "../../db/models/organization.model";

export interface IOrganizationRepository {
    findById(id: string): Promise<IOrganization | null>;
}
