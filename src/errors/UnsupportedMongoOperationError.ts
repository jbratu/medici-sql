import { MediciError } from "./MediciError";

export class UnsupportedMongoOperationError extends MediciError {
  constructor(operation: string) {
    super(`Unsupported Mongo operation for the SQLite backend: ${operation}`);
    this.name = "UnsupportedMongoOperationError";
  }
}
