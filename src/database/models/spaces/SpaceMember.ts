import { model, Schema } from "mongoose";

const spaceMemberSchema = new Schema({
    user: {
        type: String,
        required: true,
    },
    space: {
        type: String,
        required: true,
    },
    nickname: String,
    avatar: String,
    banner: String,
    roles: {
        type: [String],
        default: [],
    },
    joinedAt: Date,
    joinedTimestamp: Number,
});

const SpaceMemberModel = model("space_members", spaceMemberSchema);
export { SpaceMemberModel };
