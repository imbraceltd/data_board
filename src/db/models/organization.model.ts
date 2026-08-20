import mongoose, { Schema, Document } from "mongoose";

// Simplified Schema just for reading Partition
export interface IOrganization extends Document {
    _id: string;
    name: string;
    partition: number;
}

export const OrganizationSchema = new Schema(
    {
        _id: { type: String, required: true },
        name: { type: String, required: true },
        partition: { type: Number, default: 0 },
    },
    {
        strict: false, // Allow other fields to exist in the document
        versionKey: false,
    }
);

// We export the Schema and Interface, but NOT the default model.
// The repository will handle model compilation on the specific connection.
// keeping default export as null or undefined to prevent accidental usage
export default null;
