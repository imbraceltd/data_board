export interface AutomationBus {
    publish(topic: string, message: any, partition?: number): Promise<void>;
    disconnect(): Promise<void>;
}
