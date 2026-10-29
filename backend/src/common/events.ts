import { EventEmitter } from "node:events";

export interface CustomerMessageEvent { conversationId: string; messageId: string }

/** Bus interno. La Etapa 5 (IA) se suscribe a "customer_message". */
class AppEvents extends EventEmitter {}
export const appEvents = new AppEvents();
export const EVT_CUSTOMER_MESSAGE = "customer_message";
