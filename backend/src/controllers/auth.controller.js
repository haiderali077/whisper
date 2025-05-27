import { generateToken } from "../lib/utils.js";
import User from "../models/user.model.js"
import bcrypt from "bcryptjs"


export const signup = async (req, res) => {
    const {fullName, email, password} = req.body
    try {
        if(!fullName || !email || !password) {
            return res.status(400).json({message: "Fill all the reuqired fields"});
        }

        if (password.length < 6) {
            return res.status(400).json({ message: "Password must be at  leat 6 characters"});
        }
        const user = await User.findOne({email})
        if (user) {
            return res.status(400).json({ message: "Email already exists"});
        }
        
        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(password, salt)

        const newUser = new User({
            fullName: fullName,
            email: email,
            password: hashedPassword
        })

        if(newUser) {
            generateToken(newUser._id, res)
            await newUser.save()

            res.status(201).json({
                _id:newUser._id,
                fullName: newUser.fullName,
                email: newUser.email,
                proficlePic: newUser.profilePic,
            })

        } else {
            res.status(400).json({message: "Invalid user data"});
        }

    } catch (error) {
        console.log("Error in signup controller", error.message);
        res.status(500).json({message: "Interal Server Error"});     
    }
};

export const login = async (req, res) => {
           const {email, password} =  req.bod

    try {
       const user = await User.findOne({email})
       
       if (!user) {
        return res.status(400).json({message:"Invalid credentials"})
       }
       
       const isPasswordCorrect = await bcrypt.compare(password, user.password)
       if(!isPasswordCorrect) {
        
       }
        
    } catch (error) {
        
    }
};

export const logout = (req, res) => {
    res.send("logout route");
};