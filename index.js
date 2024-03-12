const express = require('express')
const app = express();
const cors = require('cors')
const jwt = require('jsonwebtoken');

const port = process.env.Port || 5000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');


//Middlware 
app.use(cors());
app.use(express.json())


require('dotenv').config(); // Load environment variables from .env file

const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;

const uri = `mongodb+srv://${DB_USER}:${DB_PASSWORD}@cluster0.vz4h6lc.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const MenuCollection = client.db("DBMadeBest").collection("MenuAll")
    const ReviewCollection = client.db("DBMadeBest").collection("review")
    const CartCollection = client.db("DBMadeBest").collection("cart")
    const userCollection = client.db("DBMadeBest").collection("users")

    // verify Admin check to 
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      try {
        const user = await userCollection.findOne(query);
        const isAdmin = user?.role === 'admin';

        if (!isAdmin) {
          return res.status(403).send({ message: 'Forbidden access' });
        }

        // Call next() to proceed to the next middleware
        next();
      } catch (error) {
        console.error('Error verifying admin:', error);
        return res.status(500).send({ message: 'Internal Server Error' });
      }
    };

// Middleware to verify token
const verifyToken = (req, res, next) => {
  if (!req.headers.authorization) {
      return res.status(401).send({ message: 'Unauthorized access: Token missing' });
  }
  const token = req.headers.authorization.split(' ')[1];
  try {
      const decoded = jwt.verify(token, process.env.SECRET_KEY);
      req.decoded = decoded;
      next();
  } catch (error) {
      console.error('Error verifying token:', error);
      return res.status(401).send({ message: 'Unauthorized access: Invalid token' });
  }
};



    // JWT route
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.SECRET_KEY, { expiresIn: '1h' });
      res.send({ token });
    });

    // user admin check 

    app.get('/user/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'unauthorized access' })
      }
      const query = { email: email };
      const user = await userCollection.findOne(query)
      let admin = false;
      if (user) {
        admin = user?.role === 'admin'
      }
      res.send({ admin })
    })




    // make Admin - 

    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: 'admin'
        },
      };

      const result = await userCollection.updateOne(filter, updateDoc);
      res.send(result);

    })



    //Here is Users -

    app.get('/users', verifyToken,verifyAdmin, async (req, res) => {
      console.log(req.headers)
      const result = await userCollection.find().toArray()
      res.send(result)
    })

    app.delete('/users/:id', verifyToken, verifyAdmin,  async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await userCollection.deleteOne(query);
        if (result.deletedCount === 1) {
          res.status(200).json({ success: true, message: 'User deleted successfully' });
        } else {
          res.status(404).json({ success: false, message: 'User not found' });
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });


    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = { email: user.email }
      const existingUser = await userCollection.findOne(query)
      console.log('user existing')
      if (existingUser) {
        return res.send({ message: 'user already exists', insertedId: null })

      }
      const result = await userCollection.insertOne(user)

      res.send(result);
    })

    app.get('/menu', async (req, res) => {
      const result = await MenuCollection.find().toArray();
      res.send(result)
    })

   app.post('/menu', verifyToken,verifyAdmin, async(req,res) =>{
       const item = req.body;
       const result = await MenuCollection.insertOne(item);
       res.send(result)
   })


    app.get('/review', async (req, res) => {
      const result = await ReviewCollection.find().toArray();
      res.send(result)
    })
    app.get('/carts', async (req, res) => {
      const result = await CartCollection.find().toArray();
      res.send(result)
    })
    app.get('/carts', async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const result = await CartCollection.find(query).toArray();
      res.send(result)
    })

    app.post('/carts', async (req, res) => {
      const cartItem = req.body;
      const result = await CartCollection.insertOne(cartItem)
      res.send(result)
    });

    app.delete('/carts/:id', async (req, res) => {
      const itemId = req.params.id; // Extract the ID of the item to delete from request params
      const query = { _id: new ObjectId(itemId) };
      const result = await CartCollection.deleteOne(query);
      res.send(result); // Sending the result directly may not be ideal
    });



    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('server is running')
})

app.listen(port, () => {
  console.log(`Server working properly ${port}`)
})