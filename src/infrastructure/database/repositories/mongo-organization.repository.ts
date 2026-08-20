import mongoose, { Connection, Model } from "mongoose";
import { IOrganizationRepository } from "../../../core/interfaces/organization.repository.interface";
import { OrganizationSchema, IOrganization } from "../../../db/models/organization.model";
import logger from "../../logging/logger";
import config from "../../../config";

class MongoOrganizationRepository implements IOrganizationRepository {
    private connection: Connection | null = null;
    private OrganizationModel: Model<IOrganization> | null = null;
    private static instance: MongoOrganizationRepository;

    private constructor() {
        this.connect();
    }

    public static getInstance(): MongoOrganizationRepository {
        if (!MongoOrganizationRepository.instance) {
            MongoOrganizationRepository.instance = new MongoOrganizationRepository();
        }
        return MongoOrganizationRepository.instance;
    }

    private async connect() {
        try {
            const { host, port, dbName, user, pass, isSrv, authSource } = config.backendMongo;

            let uri = "";
            if (isSrv) {
                uri = `mongodb+srv://${user}:${pass}@${host}/${dbName}`;
            } else {
                const auth = user && pass ? `${user}:${pass}@` : "";
                uri = `mongodb://${auth}${host}:${port}/${dbName}`;
            }

            if (authSource) {
                uri += (uri.includes("?") ? "&" : "?") + `authSource=${authSource}`;
            }

            logger.info(`Connecting to Backend MongoDB at ${host} (masked URI)`);

            this.connection = mongoose.createConnection(uri);

            this.connection.on("connected", () => {
                logger.info("Backend MongoDB connected successfully");
            });

            this.connection.on("error", (err) => {
                logger.error("Backend MongoDB connection error:", err);
            });

            // Register Model on this specific connection
            this.OrganizationModel = this.connection.model<IOrganization>(
                "Organization",
                OrganizationSchema
            );

        } catch (error) {
            logger.error("Failed to initialize Backend MongoDB connection:", error);
        }
    }

    private async getModel(): Promise<Model<IOrganization> | null> {
        if (!this.connection) {
            await this.connect();
        }
        return this.OrganizationModel;
    }

    public async findById(id: string): Promise<IOrganization | null> {
        const model = await this.getModel();
        if (!model) {
            logger.error("Organization Model not initialized");
            return null;
        }
        return model.findById(id);
    }
}

export default MongoOrganizationRepository;
