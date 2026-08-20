import logger from "../infrastructure/logging/logger";
import mongoose from 'mongoose';
import config from '../config';

const connectDB = async (): Promise<void> => {
  // In Postgres mode the service runs entirely through the PG adapter; the
  // legacy Mongoose connection is unused and must NOT gate startup. Skipping
  // it lets a PG-only deployment boot without a reachable Mongo (otherwise a
  // failed handshake here hits process.exit(1) and crash-loops the container).
  if (config.dbType === 'postgres') {
    logger.info('DB_TYPE=postgres — skipping legacy MongoDB connection');
    return;
  }

  try {
    await mongoose.connect(config.mongoUri);
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

export default { connect: connectDB };
