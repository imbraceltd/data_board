import dotenv from "dotenv";
dotenv.config({ path: "src/.env" });

interface Config {
  port: number;
  webapp_url: string;
  mongoUri: string;
  environment: string;
  version: string;
  fsServiceUrl: string;
  aiServiceUrl: string;
  aiProxyUrl: string;
  appGatewayHost: string;
  channelServiceUrl: string;
  /** Internal Platform service URL (.lan vhost). Used by `platform-account.client`
   *  to resolve user display names for `created_by_name` on schema versions. */
  platformServiceHost: string;
  aiMongoUrl: string;
  aiMongoDbName: string;
  aiAssistantsCollection: string;
  ipsServiceUrl: string;
  dbType: "mongodb" | "postgres";
  pgUrl: string;
  onedrive: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    redirectUri: string;
  };
  googleDrive: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    apiKey?: string;
  };
  dropbox: {
    appKey: string;
    appSecret: string;
    redirectUri: string;
  };
  kafka: {
    enabled: boolean;
    endpoint: string;
    brokers: string;
    clientId: string;
    authMethod: string;
    useSsl: boolean;
    useSasl: boolean;
    sslRejectUnauthorized: boolean;
    awsRegion: string;
    saslMechanism: string;
    saslUsername: string;
    saslPassword: string;
    defaultPartition: number;
  };
  backendMongo: {
    host: string;
    port: string;
    dbName: string;
    user: string;
    pass: string;
    isSrv: boolean;
    authSource: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
  mail: {
    smtpHost: string;
    smtpPort: number;
    smtpUsername: string;
    smtpPassword: string;
    fromEmail: string;
    fromName: string;
  };
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    s3Bucket: string;
  };
  aiAgentUrl: string;
  /** Base URL of the messagesuggestion service (host only, no trailing path). */
  messageSuggestionUrl: string;
  /** Internal marketplace service URL (host only, no trailing path). Used by the
   *  schema-link enricher to resolve the use-case id behind each linked agent
   *  via GET /v1/use-cases/by-assistant/:assistant_id. */
  marketplaceUrl: string;
}

const config: Config = {
  port: parseInt(process.env.PORT || "8081"),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/data_board",
  webapp_url: process.env.WEBAPP_URL || "http://localhost:3001",
  environment: process.env.NODE_ENV || "development",
  version: "1.0.0",
  fsServiceUrl:
    process.env.FS_SERVICE_URL || "http://localhost:8866/api/files",
  aiServiceUrl:
    process.env.AI_SERVICE_URL || "http://localhost:7101/api/v1",
  aiProxyUrl: process.env.AI_PROXY_URL || "http://localhost:3003",
  appGatewayHost:
    process.env.APP_GATEWAY_HOST || "http://localhost:9001",
  // Internal channel-service URL used for cross-service lookups (e.g. resolving
  // contact.board_id via GET /v1/contacts/:id). Default targets the docker
  // network hostname — the .lan vhost isn't exposed to the container network,
  // so `channel-service:4100` (docker service name + HTTP port) is the reliable
  // reach. Override with CHANNEL_SERVICE_URL in non-docker environments.
  channelServiceUrl:
    process.env.CHANNEL_SERVICE_URL || "http://channel-service:4100",
  platformServiceHost: process.env.PLATFORM_SERVICE_HOST || "",
  aiMongoUrl: process.env.AI_MONGO_URL || "",
  aiMongoDbName: process.env.AI_MONGO_DB_NAME || "",
  aiAssistantsCollection:
    process.env.AI_ASSISTANTS_COLLECTION || "openai_assistants",
  ipsServiceUrl:
    process.env.IPS_SERVICE_URL || "http://localhost:6006/api/v1",
  dbType: (process.env.DB_TYPE as "mongodb" | "postgres") || "postgres",
  pgUrl:
    process.env.POSTGRES_URL ||
    "postgres://postgres:postgres@localhost:5432/data_board",
  onedrive: {
    clientId: process.env.ONEDRIVE_CLIENT_ID || "",
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET || "",
    tenantId: process.env.ONEDRIVE_TENANT_ID || "",
    redirectUri:
      process.env.ONEDRIVE_REDIRECT_URI ||
      "http://localhost:8081/api/auth/onedrive/callback",
  },
  googleDrive: {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || "",
    redirectUri:
      process.env.GOOGLE_DRIVE_REDIRECT_URI ||
      "http://localhost:8081/api/auth/google-drive/callback",
    apiKey: process.env.GOOGLE_DRIVE_API_KEY || "",
  },
  dropbox: {
    appKey: process.env.DROPBOX_APP_KEY || "",
    appSecret: process.env.DROPBOX_APP_SECRET || "",
    redirectUri:
      process.env.DROPBOX_REDIRECT_URI ||
      "http://localhost:8081/api/auth/dropbox/callback",
  },
  kafka: {
    enabled: process.env.KAFKA_ENABLED !== "false",
    endpoint: process.env.KAFKA_ENDPOINT || "localhost:9092",
    brokers: process.env.KAFKA_BROKERS || "",
    clientId: process.env.KAFKA_CLIENT_ID || "data-board-service",
    authMethod: process.env.KAFKA_AUTH_METHOD || "plain",
    useSsl: process.env.KAFKA_USE_SSL === "true",
    useSasl: process.env.KAFKA_USE_SASL === "true",
    sslRejectUnauthorized:
      process.env.KAFKA_USE_SSL_REJECT_UNAUTHORIZED !== "false",
    awsRegion: process.env.KAFKA_AWS_REGION || "ap-east-1",
    saslMechanism: process.env.KAFKA_SASL_MECHANISM || "plain",
    saslUsername: process.env.KAFKA_SASL_USERNAME || "",
    saslPassword: process.env.KAFKA_SASL_PASSWORD || "",
    defaultPartition: parseInt(process.env.KAFKA_PARTITION || "0"),
  },
  backendMongo: {
    host: process.env.BACKEND_MONGODB_HOST || "localhost",
    port: process.env.BACKEND_MONGODB_PORT || "27017",
    dbName: process.env.BACKEND_MONGODB_DB_NAME || "imbrace",
    user: process.env.BACKEND_MONGODB_USERNAME || "",
    pass: process.env.BACKEND_MONGODB_PASSWORD || "",
    isSrv: process.env.BACKEND_MONGODB_SRV === "true",
    authSource: process.env.BACKEND_MONGODB_AUTH_SOURCE || "",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || "",
  },
  mail: {
    smtpHost: process.env.SMTP_ADDRESS || "",
    smtpPort: parseInt(process.env.SMTP_PORT || "587"),
    smtpUsername: process.env.SMTP_USERNAME || "",
    smtpPassword: process.env.SMTP_PASSWORD || "",
    fromEmail: process.env.SMTP_SENDER || "noreply@imbrace.co",
    fromName: process.env.SMTP_FROM_NAME || "imbrace",
  },
  aws: {
    region: process.env.AWS_REGION || "ap-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    s3Bucket: process.env.AWS_S3_BUCKET || "",
  },
  aiAgentUrl: process.env.AI_AGENT_URL || "http://localhost:7100",
  // No default: unset ⇒ requests fall back to the gateway.
  messageSuggestionUrl: process.env.MESSAGE_SUGGESTION_URL || "",
  marketplaceUrl:
    process.env.MARKETPLACE_URL || "http://localhost:9982",
};

export default config;
