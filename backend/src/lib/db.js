import mongoose from "mongoose";


export const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  console.log("MongoDB connected");
};
