import { Kafka, Producer, logLevel, SASLOptions } from "kafkajs";
// @ts-ignore
import { awsMSKSigner } from "aws-msk-iam-sasl-signer-js";
import logger from "../../infrastructure/logging/logger";
import { AutomationBus } from "../../core/interfaces/automation-bus.interface";
import config from "../../config";

class KafkaAutomation implements AutomationBus {
    private producer: Producer;
    private isConnected: boolean = false;
    private static instance: KafkaAutomation;

    private constructor() {
        const { kafka: kafkaConfigEnv } = config;
        const authMethod = kafkaConfigEnv.authMethod;
        const useSsl = kafkaConfigEnv.useSsl;
        const useSasl = kafkaConfigEnv.useSasl;
        const rejectUnauthorized = kafkaConfigEnv.sslRejectUnauthorized;

        let brokers: string[] = [];
        if (kafkaConfigEnv.brokers) {
            brokers = kafkaConfigEnv.brokers.split(",");
        } else {
            brokers = [kafkaConfigEnv.endpoint];
        }

        const clientId = kafkaConfigEnv.clientId;

        let ssl: any = false;
        if (useSsl || authMethod === 'iam') {
            ssl = { rejectUnauthorized };
            if (authMethod === 'iam') {
                ssl = true;
            }
        }

        let sasl: SASLOptions | undefined;

        if (authMethod === 'iam') {
            const region = kafkaConfigEnv.awsRegion;
            sasl = {
                mechanism: 'oauthbearer',
                oauthBearerProvider: async () => {
                    const signer = new awsMSKSigner(region);
                    const token = await signer.generateAuthToken();
                    return { value: token };
                }
            };
        } else if (useSasl) {
            sasl = {
                mechanism: (kafkaConfigEnv.saslMechanism.toLowerCase() as any) || 'plain',
                username: kafkaConfigEnv.saslUsername,
                password: kafkaConfigEnv.saslPassword
            };
        }

        const kafkaInitConfig: any = {
            clientId,
            brokers,
            logLevel: logLevel.ERROR,
            retry: {
                initialRetryTime: 100,
                retries: 5,
            },
        };

        if (ssl) kafkaInitConfig.ssl = ssl;
        if (sasl) kafkaInitConfig.sasl = sasl;
        logger.info("Kafka configuration initialized", { kafkaConfig: kafkaInitConfig });

        const kafka = new Kafka(kafkaInitConfig);
        this.producer = kafka.producer();
        this.connect();
    }

    public static getInstance(): KafkaAutomation {
        if (!KafkaAutomation.instance) {
            KafkaAutomation.instance = new KafkaAutomation();
        }
        return KafkaAutomation.instance;
    }

    private async connect() {
        try {
            await this.producer.connect();
            this.isConnected = true;
            logger.info("Kafka producer connected successfully");
        } catch (error) {
            logger.error("Failed to connect Kafka producer:", error);
        }
    }

    public async publish(topic: string, message: any, partition?: number): Promise<void> {
        if (!this.isConnected) {
            await this.connect();
        }

        try {
            const targetPartition = partition !== undefined
                ? partition
                : config.kafka.defaultPartition;

            await this.producer.send({
                topic,
                messages: [
                    {
                        value: JSON.stringify(message),
                        partition: targetPartition
                    }
                ]
            });
            logger.info(`Message published to topic ${topic} partition ${targetPartition}`, {
                messageType: message.type,
                fileIds: message.files?.map((file: any) => file._id)
            });
        } catch (error) {
            logger.error(`Failed to publish message to ${topic}:`, error);
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        if (this.isConnected) {
            await this.producer.disconnect();
            this.isConnected = false;
            logger.info("Kafka producer disconnected");
        }
    }
}

export default KafkaAutomation;
