/**
 * ITD-95 alias probe (ticket DoD): proves the "mongoose" module alias resolves
 * to src/compat/mongoose.ts at runtime and that Types.ObjectId is a bson
 * ObjectId. Port-specific file — not part of the vendored upstream suite.
 */
import { expect } from "chai";
import { ObjectId } from "bson";
import { Types } from "mongoose";

describe("module alias probe (ITD-95)", function () {
  it("resolves 'mongoose' to the compat module with a bson-backed Types.ObjectId", function () {
    const id = new Types.ObjectId();
    expect(id).to.be.instanceOf(ObjectId);
    expect(id._id).to.equal(id);
    expect(id.toString()).to.match(/^[0-9a-f]{24}$/);
  });
});
