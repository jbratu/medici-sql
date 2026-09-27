/* eslint sonarjs/no-duplicate-string: off */
import { expect } from "chai";
import { ObjectId as BsonObjectId } from "bson";
import { Schema, Types, ValidationError, connect, disconnect, connection, model } from "mongoose";
import { MediciError, UnsupportedMongoOperationError } from "../src/errors";
import { setTransactionSchema, transactionSchema, transactionModel } from "../src/models/transaction";
// The DB-free checkpoint's import graph loads only the transaction and
// balance models; the full suite registers journal/lock through Book.ts.
// Force-load them here so the registry assertions mirror the full suite.
import "../src/models/journal";
import "../src/models/lock";

describe("compat core A (ITD-91)", () => {
  describe("Types.ObjectId (QA M4/S10)", () => {
    it("has an _id getter returning itself", () => {
      const id = new Types.ObjectId();
      expect(id._id).to.equal(id);
      expect(id._id._id).to.equal(id);
    });

    it("is a bson ObjectId subclass without patching bson's prototype", () => {
      const id = new Types.ObjectId();
      expect(id).to.be.instanceof(Types.ObjectId);
      expect(id).to.be.instanceof(BsonObjectId);
      expect(new BsonObjectId()._id).to.equal(undefined);
    });

    it("round-trips hex strings and timestamps", () => {
      const hex = new BsonObjectId().toHexString();
      expect(new Types.ObjectId(hex).toString()).to.equal(hex);
      const fromInstance = new Types.ObjectId(new BsonObjectId(hex));
      expect(fromInstance.toString()).to.equal(hex);
      expect(new Types.ObjectId().getTimestamp()).to.be.instanceof(Date);
    });
  });

  describe("Schema (QA M5)", () => {
    it("includes an implicit _id path that is an ObjectId", () => {
      const schema = new Schema({ test: String });
      expect(schema.paths).to.have.property("_id");
      expect(schema.paths._id).to.be.instanceof(Schema.Types.ObjectId);
    });

    it("accepts a bare Schema.Types.ObjectId path definition", () => {
      const schema = new Schema({ _journal: Schema.Types.ObjectId, test: String });
      expect(schema.paths._journal).to.be.instanceof(Schema.Types.ObjectId);
      expect(schema.paths.test).to.not.be.instanceof(Schema.Types.ObjectId);
    });

    it("accepts { type, ref } and array-of-object definitions", () => {
      const schema = new Schema({
        _journal: { type: Schema.Types.ObjectId, ref: "Medici_Journal" },
        _transactions: [{ type: Schema.Types.ObjectId, ref: "Medici_Transaction" }],
        memo: { type: String, default: "" },
      });
      expect((schema.paths._journal as any).ref).to.equal("Medici_Journal");
      const arrayPath = schema.paths._transactions as any;
      expect(arrayPath.element).to.be.instanceof(Schema.Types.ObjectId);
      expect(arrayPath.element.ref).to.equal("Medici_Transaction");
      expect(schema.paths.memo.hasDefault).to.equal(true);
      expect(schema.paths.memo.default).to.equal("");
    });

    it("accepts the bare Types.ObjectId value class as a definition", () => {
      const schema = new Schema({ transaction: Types.ObjectId, key: String });
      expect(schema.paths.transaction).to.be.instanceof(Schema.Types.ObjectId);
    });

    it("records .index() calls and keeps options inert", () => {
      const schema = new Schema({ key: String }, { id: false, versionKey: false, timestamps: false });
      schema.index({ key: 1 });
      schema.index({ book: 1, datetime: -1 }, { unique: true });
      expect(schema.indexes).to.have.lengthOf(2);
      expect(schema.indexes[1].options).to.deep.equal({ unique: true });
      expect(schema.options).to.deep.equal({ id: false, versionKey: false, timestamps: false });
    });
  });

  describe("Model and Document (QA M6)", () => {
    it("generates _id at construction, before any insert", () => {
      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        meta: { note: "x" },
        datetime: new Date(),
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId(),
        timestamp: new Date(),
      });
      expect(doc._id).to.be.instanceof(Types.ObjectId);
      expect(doc._id._id).to.equal(doc._id);
    });

    it("resolve()s validate() for a well-typed document and casts where possible", async () => {
      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        datetime: 1700000000000,
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId().toHexString(),
        timestamp: new Date(),
      });
      await doc.validate();
      expect(doc.datetime).to.be.instanceof(Date);
      expect(doc._journal).to.be.instanceof(Types.ObjectId);
    });

    it("rejects validate() with the contract message shape for a bad datetime", async () => {
      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        datetime: "invalid",
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId(),
        timestamp: new Date(),
      });
      try {
        await doc.validate();
        expect.fail("validate() should have rejected");
      } catch (err) {
        expect(err).to.be.instanceof(ValidationError);
        expect(err.message).to.match(/^Medici_Transaction validation failed: datetime: /);
      }
    });

    it("keeps the model name in the validation message across deleteModel + re-register", async () => {
      connection.deleteModel("Medici_Transaction");
      setTransactionSchema(transactionSchema);

      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        datetime: "still invalid",
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId(),
        timestamp: new Date(),
      });
      try {
        await doc.validate();
        expect.fail("validate() should have rejected");
      } catch (err) {
        expect(err.message).to.match(/^Medici_Transaction validation failed: datetime: /);
      }

      // restore the original registration for the other spec files
      connection.deleteModel("Medici_Transaction");
      setTransactionSchema(transactionSchema);
    });

    it("toObject() returns a plain object without internals", () => {
      const doc: any = new (transactionModel as any)({
        credit: 1,
        debit: 2,
        datetime: new Date(),
        account_path: ["A"],
        accounts: "A",
        book: "B",
        memo: "m",
        _journal: new Types.ObjectId(),
        timestamp: new Date(),
      });
      const plain = doc.toObject();
      expect(Object.getPrototypeOf(plain)).to.equal(Object.prototype);
      expect(plain.credit).to.equal(1);
      expect(plain._id).to.equal(doc._id);
      expect(plain).to.not.have.property("_model");
    });

    it("diffIndexes() returns the sanctioned minimal shape (QA R4)", () => {
      expect((transactionModel as any).diffIndexes()).to.deep.equal({ toDrop: [], toCreate: [] });
    });

    it("wires .collection to the raw Prisma adapter (ITD-93)", () => {
      const collection = (transactionModel as any).collection;
      expect(collection).to.not.equal(undefined);
      expect(typeof collection.insertOne).to.equal("function");
      expect(typeof collection.insertMany).to.equal("function");
      expect(typeof collection.updateOne).to.equal("function");
      expect(typeof collection.updateMany).to.equal("function");
      expect(typeof collection.find).to.equal("function");
      expect(typeof collection.findOne).to.equal("function");
      expect(typeof collection.countDocuments).to.equal("function");
      expect(typeof collection.deleteOne).to.equal("function");
      expect(typeof collection.deleteMany).to.equal("function");
      expect(typeof collection.aggregate).to.equal("function");
      expect(typeof collection.distinct).to.equal("function");
    });

    it("keeps the loud-failure proxy for models whose table is not a medici table", () => {
      const scratch = model("Scratch_ITD93", new Schema({ x: String }));
      const collection = (scratch as any).collection;
      expect(() => collection.insertOne({})).to.throw(UnsupportedMongoOperationError);
      expect(() => collection.insertOne({})).to.throw(/ITD-93/);
      connection.deleteModel("Scratch_ITD93");
    });
  });

  describe("connection (QA M6)", () => {
    it("registers the verbatim models at import and deleteModel returns the model", () => {
      expect(connection.models).to.have.all.keys(
        "Medici_Transaction",
        "Medici_Journal",
        "Medici_Balance",
        "Medici_Lock"
      );
      const scratch = model("Scratch_ITD91", new Schema({ x: String }));
      expect(scratch).to.not.equal(undefined);
      const removed = connection.deleteModel("Scratch_ITD91");
      expect(removed).to.equal(scratch);
      expect(connection.models).to.not.have.property("Scratch_ITD91");
    });

    it("connect()/disconnect() throw until the Prisma-backed lifecycle lands (ITD-102)", async () => {
      let connectError: unknown;
      try {
        await connect();
      } catch (err) {
        connectError = err;
      }
      expect(connectError).to.be.instanceof(UnsupportedMongoOperationError);
      expect(connectError).to.be.instanceof(MediciError);

      let disconnectError: unknown;
      try {
        await disconnect();
      } catch (err) {
        disconnectError = err;
      }
      expect(disconnectError).to.be.instanceof(UnsupportedMongoOperationError);
    });
  });

  describe("UnsupportedMongoOperationError", () => {
    it("extends MediciError with its own name", () => {
      const err = new UnsupportedMongoOperationError("Model.X.find");
      expect(err).to.be.instanceof(MediciError);
      expect(err).to.be.instanceof(Error);
      expect(err.name).to.equal("UnsupportedMongoOperationError");
      expect(err.code).to.equal(500);
      expect(err.message).to.equal("Unsupported Mongo operation for the SQLite backend: Model.X.find");
    });
  });
});
