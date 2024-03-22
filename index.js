const express = require('express')
const app = express();
const cors = require('cors')
const SSLCommerzPayment = require('sslcommerz-lts')
const jwt = require('jsonwebtoken');
// SSLCommerche
require('dotenv').config();

const port = process.env.Port || 5000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');



const store_id = 'ahsof65f6f6e76876a';
const store_passwd = 'ahsof65f6f6e76876a@ssl';
const is_live = process.env.IS_LIVE === 'true';
// Convert to boolean

// Now you can use store_id, store_passwd, and is_live in your SSLCommerzPayment configuration



//Middlware 
app.use(cors());
app.use(express.json())



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
    const orderColllection = client.db("DBMadeBest").collection("order")
    const bookingColllection = client.db("DBMadeBest").collection("Booking")
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

  //  booking

  app.post('/booking', async (req, res) => {
    const bookingItem = req.body;
    const result = await bookingColllection.insertOne(bookingItem)
    console.log(result)
    res.send(result)
  });




  //  order 



    app.post('/order', async (req, res) => {
      try {
        const trans_id = new ObjectId().toString();
        const orderData = req.body;
        // Array to store product details
        const products = [];
        // Fetch product details for each item in cart
        for (const item of orderData.cartItems) {
          const product = await CartCollection.findOne({ _id: new ObjectId(item.productId) });
          products.push(product);
        }

        // Calculate total amount based on product prices
        const total_amount = products.reduce((total, product) => total + parseFloat(product.price), 0);

        const paymentData = {
          total_amount: total_amount.toFixed(2),
          currency: 'BDT',
          tran_id: trans_id,
          success_url: `http://localhost:5000/payment/success/${trans_id}`,
          fail_url: `http://localhost:5000/payment/failed/${trans_id}`,
          cancel_url: 'http://localhost:3030/cancel',
          ipn_url: 'http://localhost:3030/ipn',
          shipping_method: 'Courier',
          product_name: products.map(product => product.title).join(', '),
          product_category: products.map(product => product.category).join(', '),
          product_profile: 'general',
          cus_name: orderData.name,
          cus_email: orderData.Email,
          cus_add1: orderData.address,
          cus_phone: orderData.phoneNumber,
          ship_name: 'Customer Name',
          ship_add1: 'Dhaka',
          ship_add2: 'Dhaka',
          ship_city: 'Dhaka',
          ship_state: 'Dhaka',
          ship_postcode: 1000,
          ship_country: 'Bangladesh',
        };


        console.log('Payment Data:', paymentData);

       

        const sslcommerz = new SSLCommerzPayment(process.env.STORE_ID, process.env.STORE_PASSWORD, false); // Change 'false' to 'true' for live environment

        sslcommerz.init(paymentData)
          .then((apiResponse) => {
            if (apiResponse && apiResponse.GatewayPageURL) {
              let GatewayPageURL = apiResponse.GatewayPageURL;
              res.send({ url: GatewayPageURL });
              console.log('Redirecting to:', GatewayPageURL);
              const finalOrder = {
                ...orderData, total_amount, paidStatus: false, transaction_id: trans_id
              }
      
              // Insert order data into the database
              const result =  orderColllection.insertOne(finalOrder);
              console.log('Order placed:', result.insertedId);
              
            } else {
              console.error('Invalid API response:', apiResponse);
              res.status(500).send({ error: 'Invalid API response' });
            }
          })
          .catch((error) => {
            console.error('Error initializing payment:', error);
            res.status(500).send({ error: 'Error initializing payment' });
          });


          app.post('/payment/success/:tranId', async (req, res) => {
            try {
                console.log(req.params.tranId);
                const result = await orderColllection.updateOne({
                    transaction_id: req.params.tranId
                }, {
                    $set: {
                        paidStatus: true,
                    }
                });
        
                if (result.modifiedCount > 0) {
                    res.redirect(`http://localhost:5173/payment/success/${req.params.tranId}`);
                } else {
                    // If no document was modified, return a 404 status
                    res.status(404).send('No order found for the provided transaction ID');
                }
            } catch (error) {
                // Handle any errors that occur during the database operation
                console.error('Error updating order status:', error);
                res.status(500).send({ error: 'Error updating order status' });
            }
        });

        app.post('/payment/failed/:tranId', async (req, res) => {
    try {
        console.log(req.params.tranId);
        const result = await orderColllection.deleteOne({
            transaction_id: req.params.tranId
        })
        if (result.deletedCount) {
          res.redirect(`http://localhost:5173/payment/failed/${req.params.tranId}`);
           
        } 
    } catch (error) {
        // Handle any errors that occur during the database operation
        console.error('Error updating order status for failed payment:', error);
        res.status(500).send({ error: 'Error updating order status for failed payment' });
    }
});




      } catch (error) {
        console.error('Error processing order:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });


    app.get('/order', verifyToken, verifyAdmin, async (req, res) => {
      console.log(req.headers)
      const result = await orderColllection.find().toArray()
      res.send(result)
    })


    app.delete('/order/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await orderColllection.deleteOne(query);
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

    //Admin State

    app.get('/general', async(req,res) => {
      try {
          const users = await userCollection.estimatedDocumentCount();
          const menuItems = await MenuCollection.estimatedDocumentCount();
          const orders = await orderColllection.estimatedDocumentCount();

          const result = await orderColllection.aggregate([
            {
              $group: {
                _id: null,
                totalRevenue: {
                  $sum: '$total_amount' // Assuming 'total_amount' is the field in your order documents representing the total amount
                }
              }
            }
          ]).toArray();
          
          console.log(result)
        const revenue = result.length > 0 ? result[0].totalRevenue : 0;

  
          console.log("Revenue:", revenue ); // Log revenue to console for debugging
  
          res.send({
              users,
              menuItems,
              orders,
              revenue
          });
      } catch (error) {
          console.error("Error fetching general statistics:", error);
          res.status(500).send({ error: "Internal Server Error" });
      }
  });
  
// app.get('/general-states', async (req, res) => {
//     try {
//         const result = await orderColllection.aggregate([
//           {
//             $match: {
//               cartItems: { $exists: true, $ne: [] } // Filter orders with non-empty cartItems arrays
//             }
//           },
//           {
//             $unwind: '$cartItems'
//           },
//           {
//             $lookup: {
//               from: 'menu',
//               localField: 'cartItems.productId',
//               foreignField: '_id',
//               as: 'menuItems'
//             }
//           },
//           {
//             $unwind: {
//               path: '$menuItems',
//               preserveNullAndEmptyArrays: true // Preserve documents even if menuItems array is empty
//             }
//           },
//           {
//             $group: {
//               _id: '$menuItems.category',
//               quantity: { $sum: '$cartItems.quantity' },
//               revenue: { $sum: { $multiply: ['$menuItems.price', '$cartItems.quantity'] } }
//             }
//           }
          
//         ]).toArray();

//         res.send(result);
//     } catch (error) {
//         console.error("Error fetching general states:", error);
//         res.status(500).json({ error: "Internal Server Error" });
//     }
// });




    //Here is Users -

    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      console.log(req.headers)
      const result = await userCollection.find().toArray()
      res.send(result)
    })

    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
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

    app.post('/menu', verifyToken, verifyAdmin, async (req, res) => {
      const item = req.body;
      const result = await MenuCollection.insertOne(item);
      res.send(result)
    })

    app.delete('/menu/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await MenuCollection.deleteOne(query);
      res.send(result);
    })
    app.patch('/menu/:id', async (req, res) => {
      const item = req.body;
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          Title: item.Title,
          category: item.category,
          price: item.price,
          description: item.description
        }
      }
      const result = await MenuCollection.updateDoc(filter, updateDoc)
      res.send(result)
    })


    app.get('/review', async (req, res) => {
      const result = await ReviewCollection.find().toArray();
      res.send(result)
    })
   

    app.get('/carts', async (req, res) => {
      try {
        if (req.query.email) {
          const email = req.query.email;
          const query = { email: email };
          const result = await CartCollection.find(query).toArray();
          res.send(result);
        } else {
          const result = await CartCollection.find().toArray();
          res.send(result);
        }
      } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
      }
    });



    app.patch('/carts/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const { quantity } = req.body;

      try {
        // Validate the quantity
        if (!Number.isInteger(quantity) || quantity < 0) {
          return res.status(400).json({ error: 'Invalid quantity' });
        }

        // Find and update the cart item
        const updatedCartItem = await CartCollection.findOneAndUpdate(
          query,
          { $set: { quantity: quantity } },
          { new: true }
        );

        // Check if the cart item exists
        if (!updatedCartItem) {
          return res.status(404).json({ error: 'Item not found' });
        }

        // Respond with the updated cart item
        res.status(200).json(updatedCartItem);
      } catch (error) {
        console.error('Error updating item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

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