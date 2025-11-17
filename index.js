const express = require('express')
const app = express();
const cors = require('cors')
const compression = require('compression')
const SSLCommerzPayment = require('sslcommerz-lts')
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
require('dotenv').config();

const port = process.env.PORT || process.env.Port || 5000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// Enable compression for all responses
app.use(compression());
app.use(cors());
app.use(express.json());

// Response caching for static data
const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache

// Simple in-memory rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 100;

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const { count, resetTime } = rateLimitMap.get(ip);
  
  if (now > resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  if (count >= MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  rateLimitMap.set(ip, { count: count + 1, resetTime });
  next();
}

app.use(rateLimitMiddleware);

const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_HOST = process.env.DB_HOST || 'cluster0.vz4h6lc.mongodb.net';
const MONGODB_URI = process.env.MONGODB_URI;

const uri = MONGODB_URI || (
  DB_USER && DB_PASSWORD
    ? `mongodb+srv://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/?retryWrites=true&w=majority&appName=Cluster0`
    : null
);

if (!uri) {
  throw new Error('Missing MongoDB credentials. Please set MONGODB_URI or DB_USER/DB_PASSWORD.');
}

// Create a MongoClient with optimized settings
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 20, // Increased for better concurrency
  minPoolSize: 5, // Maintain minimum connections
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxIdleTimeMS: 30000,
  retryWrites: true,
  retryReads: true,
});

// Collections reference
let MenuCollection, ReviewCollection, CartCollection, userCollection, orderColllection, bookingColllection;

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

// Verify Admin check with caching
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  
  // Check cache first
  const cacheKey = `admin-${email}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    if (!cached) return res.status(403).send({ message: 'Forbidden access' });
    return next();
  }

  try {
    const user = await userCollection.findOne({ email });
    const isAdmin = user?.role === 'admin';
    
    cache.set(cacheKey, isAdmin, 600);
    
    if (!isAdmin) {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    next();
  } catch (error) {
    console.error('Error verifying admin:', error);
    return res.status(500).send({ message: 'Internal Server Error' });
  }
};

async function run() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');

    MenuCollection = client.db("DBMadeBest").collection("MenuAll")
    ReviewCollection = client.db("DBMadeBest").collection("review")
    CartCollection = client.db("DBMadeBest").collection("cart")
    userCollection = client.db("DBMadeBest").collection("users")
    orderColllection = client.db("DBMadeBest").collection("order")
    bookingColllection = client.db("DBMadeBest").collection("Booking")

    // Create indexes for better query performance
    // Use sparse unique index for transaction_id to allow multiple null values
    try {
      // Drop existing transaction_id index if it exists (to recreate with sparse option)
      try {
        await orderColllection.dropIndex('transaction_id_1');
        console.log('Dropped existing transaction_id index');
      } catch (err) {
        // Index doesn't exist or already dropped, continue
      }

      await Promise.all([
        userCollection.createIndex({ email: 1 }, { unique: true }),
        userCollection.createIndex({ role: 1 }),
        CartCollection.createIndex({ email: 1 }),
        CartCollection.createIndex({ email: 1, _id: 1 }), // Compound index for cart queries
        orderColllection.createIndex({ transaction_id: 1 }, { unique: true, sparse: true }), // Sparse allows multiple nulls
        orderColllection.createIndex({ email: 1 }),
        orderColllection.createIndex({ paidStatus: 1 }),
        MenuCollection.createIndex({ category: 1 }),
        MenuCollection.createIndex({ _id: 1, category: 1 }), // Compound index
        ReviewCollection.createIndex({ createdAt: -1 }), // For sorting reviews
        bookingColllection.createIndex({ email: 1 }),
        bookingColllection.createIndex({ date: 1 }),
      ]);
      console.log('All indexes created successfully');
    } catch (error) {
      console.error('Error creating indexes (some may already exist):', error.message);
      // Continue even if some indexes fail (they may already exist)
    }

    // JWT route
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.SECRET_KEY, { expiresIn: '1h' });
      res.send({ token });
    });

    // Booking
    app.post('/booking', async (req, res) => {
      try {
        const bookingItem = req.body;
        const result = await bookingColllection.insertOne(bookingItem);
        res.send(result);
      } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).send({ error: 'Failed to create booking' });
      }
    });

    // Order - Optimized with Promise.all for parallel fetching
    app.post('/order', async (req, res) => {
      try {
        const trans_id = new ObjectId().toString();
        const orderData = req.body;
        
        // Optimize: Fetch all products in parallel instead of sequential
        const products = await Promise.all(
          orderData.cartItems.map(item => 
            CartCollection.findOne({ _id: new ObjectId(item.productId) })
          )
        );

        // Calculate total amount
        const total_amount = products.reduce((total, product) => total + parseFloat(product.price || 0), 0);

        const paymentData = {
          total_amount: total_amount.toFixed(2),
          currency: 'BDT',
          tran_id: trans_id,
          success_url: `https://madebestresturent.vercel.app/payment/success/${trans_id}`,
          fail_url: `https://madebestresturent.vercel.app/payment/failed/${trans_id}`,
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

        const sslcommerz = new SSLCommerzPayment(process.env.STORE_ID, process.env.STORE_PASSWORD, false);

        sslcommerz.init(paymentData)
          .then((apiResponse) => {
            if (apiResponse && apiResponse.GatewayPageURL) {
              const GatewayPageURL = apiResponse.GatewayPageURL;
              res.send({ url: GatewayPageURL });
              
              const finalOrder = {
                ...orderData, 
                total_amount, 
                paidStatus: false, 
                transaction_id: trans_id
              };

              // Insert order data into the database (non-blocking)
              orderColllection.insertOne(finalOrder).catch(err => 
                console.error('Error inserting order:', err)
              );
            } else {
              console.error('Invalid API response:', apiResponse);
              res.status(500).send({ error: 'Invalid API response' });
            }
          })
          .catch((error) => {
            console.error('Error initializing payment:', error);
            res.status(500).send({ error: 'Error initializing payment' });
          });
      } catch (error) {
        console.error('Error processing order:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Payment success - Fixed nested endpoint issue
    app.post('/payment/success/:tranId', async (req, res) => {
      try {
        const result = await orderColllection.updateOne(
          { transaction_id: req.params.tranId },
          { $set: { paidStatus: true } }
        );

        if (result.modifiedCount > 0) {
          res.redirect(`http://localhost:5173/payment/success/${req.params.tranId}`);
        } else {
          res.status(404).send('No order found for the provided transaction ID');
        }
      } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).send({ error: 'Error updating order status' });
      }
    });

    // Payment failed
    app.post('/payment/failed/:tranId', async (req, res) => {
      try {
        const result = await orderColllection.deleteOne({ transaction_id: req.params.tranId });
        if (result.deletedCount) {
          res.redirect(`http://localhost:5173/payment/failed/${req.params.tranId}`);
        } else {
          res.status(404).send('Order not found');
        }
      } catch (error) {
        console.error('Error handling failed payment:', error);
        res.status(500).send({ error: 'Error handling failed payment' });
      }
    });

    // Get orders with caching, pagination, and HTTP headers
    app.get('/order', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;
        
        const cacheKey = `all-orders-${page}-${limit}`;
        const cached = cache.get(cacheKey);
        
        // Set HTTP cache headers
        res.set({
          'Cache-Control': 'private, max-age=60', // 1 minute (private for admin)
        });
        
        if (cached) {
          return res.send(cached);
        }

        // Fetch with pagination and sort by latest first
        const [result, total] = await Promise.all([
          orderColllection.find()
            .sort({ _id: -1 }) // Latest first
            .skip(skip)
            .limit(limit)
            .toArray(),
          orderColllection.estimatedDocumentCount()
        ]);
        
        const response = {
          data: result,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        };
        
        cache.set(cacheKey, response, 60); // Cache for 1 minute
        res.send(response);
      } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).send({ error: 'Failed to fetch orders' });
      }
    });

    // Delete order
    app.delete('/order/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await orderColllection.deleteOne(query);
        
        if (result.deletedCount === 1) {
          // Invalidate all order caches (pagination)
          const keys = cache.keys();
          keys.forEach(key => {
            if (key.startsWith('all-orders-')) {
              cache.del(key);
            }
          });
          cache.del('general-stats'); // Also invalidate stats
          res.status(200).json({ success: true, message: 'Order deleted successfully' });
        } else {
          res.status(404).json({ success: false, message: 'Order not found' });
        }
      } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // User admin check - optimized with projection
    app.get('/user/admin/:email', verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
          return res.status(403).send({ message: 'unauthorized access' });
        }

        // Check cache first
        const cacheKey = `admin-${email}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          return res.send({ admin: cached });
        }

        // Use projection to only fetch role field
        const user = await userCollection.findOne(
          { email: email },
          { projection: { role: 1 } }
        );
        const admin = user?.role === 'admin';
        
        cache.set(cacheKey, admin, 600); // Cache for 10 minutes
        res.send({ admin });
      } catch (error) {
        console.error('Error checking admin status:', error);
        res.status(500).send({ error: 'Internal server error' });
      }
    });

    // Make Admin
    app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: { role: 'admin' } };
        
        const result = await userCollection.updateOne(filter, updateDoc);
        // Invalidate all user caches (pagination)
        const keys = cache.keys();
        keys.forEach(key => {
          if (key.startsWith('all-users-')) {
            cache.del(key);
          }
        });
        // Also invalidate admin cache for this user
        const user = await userCollection.findOne(filter, { projection: { email: 1 } });
        if (user) {
          cache.del(`admin-${user.email}`);
        }
        res.send(result);
      } catch (error) {
        console.error('Error making user admin:', error);
        res.status(500).send({ error: 'Internal server error' });
      }
    });

    // Admin general stats - optimized with parallel queries and caching
    app.get('/general', async (req, res) => {
      try {
        const cacheKey = 'general-stats';
        const cached = cache.get(cacheKey);
        
        // Set HTTP cache headers
        res.set({
          'Cache-Control': 'private, max-age=60', // 1 minute
        });
        
        if (cached) {
          return res.send(cached);
        }

        // Optimized parallel queries with better aggregation
        const [users, menuItems, orders, revenueResult, paidOrders] = await Promise.all([
          userCollection.estimatedDocumentCount(),
          MenuCollection.estimatedDocumentCount(),
          orderColllection.estimatedDocumentCount(),
          orderColllection.aggregate([
            {
              $match: { paidStatus: true }
            },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: { $toDouble: '$total_amount' } }
              }
            }
          ]).toArray(),
          orderColllection.countDocuments({ paidStatus: true })
        ]);

        const revenue = revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;
        const stats = { 
          users, 
          menuItems, 
          orders, 
          paidOrders,
          revenue 
        };

        cache.set(cacheKey, stats, 60); // Cache for 1 minute
        res.send(stats);
      } catch (error) {
        console.error("Error fetching general statistics:", error);
        res.status(500).send({ error: "Internal Server Error" });
      }
    });

    // Get users with caching, pagination, and projection
    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;
        
        const cacheKey = `all-users-${page}-${limit}`;
        const cached = cache.get(cacheKey);
        
        // Set HTTP cache headers
        res.set({
          'Cache-Control': 'private, max-age=60', // 1 minute (private for admin)
        });
        
        if (cached) {
          return res.send(cached);
        }

        // Use projection to exclude sensitive data and reduce payload
        const [result, total] = await Promise.all([
          userCollection.find({}, {
            projection: {
              _id: 1,
              name: 1,
              email: 1,
              role: 1,
              photoURL: 1,
              createdAt: 1
              // Exclude password and other sensitive fields
            }
          })
            .sort({ _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          userCollection.estimatedDocumentCount()
        ]);
        
        const response = {
          data: result,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        };
        
        cache.set(cacheKey, response, 60); // Cache for 1 minute
        res.send(response);
      } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).send({ error: 'Failed to fetch users' });
      }
    });

    // Delete user
    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await userCollection.deleteOne(query);
        
        if (result.deletedCount === 1) {
          // Invalidate all user caches (pagination)
          const keys = cache.keys();
          keys.forEach(key => {
            if (key.startsWith('all-users-')) {
              cache.del(key);
            }
          });
          cache.del('general-stats'); // Also invalidate stats
          res.status(200).json({ success: true, message: 'User deleted successfully' });
        } else {
          res.status(404).json({ success: false, message: 'User not found' });
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    });

    // Create user
    app.post('/users', async (req, res) => {
      try {
        const user = req.body;
        const query = { email: user.email };
        const existingUser = await userCollection.findOne(query);
        
        if (existingUser) {
          return res.send({ message: 'user already exists', insertedId: null });
        }
        
        const result = await userCollection.insertOne(user);
        // Invalidate all user caches (pagination)
        const keys = cache.keys();
        keys.forEach(key => {
          if (key.startsWith('all-users-')) {
            cache.del(key);
          }
        });
        cache.del('general-stats'); // Also invalidate stats
        res.send(result);
      } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).send({ error: 'Failed to create user' });
      }
    });

    // Get menu with caching and HTTP cache headers
    app.get('/menu', async (req, res) => {
      try {
        const cacheKey = 'all-menu';
        const cached = cache.get(cacheKey);
        
        // Set HTTP cache headers for client-side caching
        res.set({
          'Cache-Control': 'public, max-age=300', // 5 minutes
          'ETag': `"${cacheKey}-${Date.now()}"`,
        });
        
        if (cached) {
          return res.send(cached);
        }

        // Use projection to only fetch needed fields (reduce data transfer)
        const result = await MenuCollection.find({}, {
          projection: {
            _id: 1,
            Title: 1,
            category: 1,
            price: 1,
            description: 1,
            img: 1
          }
        }).toArray();
        
        cache.set(cacheKey, result, 300); // Cache for 5 minutes
        res.send(result);
      } catch (error) {
        console.error('Error fetching menu:', error);
        res.status(500).send({ error: 'Failed to fetch menu' });
      }
    });

    // Create menu item
    app.post('/menu', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const item = req.body;
        const result = await MenuCollection.insertOne(item);
        cache.del('all-menu'); // Invalidate cache
        res.send(result);
      } catch (error) {
        console.error('Error creating menu item:', error);
        res.status(500).send({ error: 'Failed to create menu item' });
      }
    });

    // Delete menu item
    app.delete('/menu/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await MenuCollection.deleteOne(query);
        
        cache.del('all-menu'); // Invalidate cache
        res.send(result);
      } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).send({ error: 'Failed to delete menu item' });
      }
    });

    // Update menu item - Fixed typo updateDoc -> updateOne
    app.patch('/menu/:id', async (req, res) => {
      try {
        const item = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            Title: item.Title,
            category: item.category,
            price: item.price,
            description: item.description
          }
        };
        
        const result = await MenuCollection.updateOne(filter, updateDoc);
        cache.del('all-menu'); // Invalidate cache
        res.send(result);
      } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).send({ error: 'Failed to update menu item' });
      }
    });

    // Get review with caching, sorting, and HTTP headers
    app.get('/review', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100; // Limit reviews
        const cacheKey = `all-reviews-${limit}`;
        const cached = cache.get(cacheKey);
        
        // Set HTTP cache headers
        res.set({
          'Cache-Control': 'public, max-age=300', // 5 minutes
        });
        
        if (cached) {
          return res.send(cached);
        }

        // Sort by latest first and limit results
        const result = await ReviewCollection.find({}, {
          projection: {
            _id: 1,
            name: 1,
            rating: 1,
            details: 1,
            image: 1,
            createdAt: 1
          }
        })
          .sort({ _id: -1 })
          .limit(limit)
          .toArray();
        
        cache.set(cacheKey, result, 300); // Cache for 5 minutes
        res.send(result);
      } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).send({ error: 'Failed to fetch reviews' });
      }
    });

    // Get carts with optimized query, projection, and HTTP headers
    app.get('/carts', async (req, res) => {
      try {
        if (req.query.email) {
          const email = req.query.email;
          const cacheKey = `carts-${email}`;
          const cached = cache.get(cacheKey);
          
          // Set HTTP cache headers
          res.set({
            'Cache-Control': 'private, max-age=30', // 30 seconds (private per user)
          });
          
          if (cached) {
            return res.send(cached);
          }

          // Use projection and index for faster query
          const result = await CartCollection.find(
            { email },
            {
              projection: {
                _id: 1,
                menuId: 1,
                email: 1,
                title: 1,
                price: 1,
                image: 1,
                quantity: 1
              }
            }
          ).toArray();
          
          cache.set(cacheKey, result, 30); // Cache for 30 seconds
          res.send(result);
        } else {
          // Admin access - no caching for all carts
          const result = await CartCollection.find({}, {
            projection: {
              _id: 1,
              menuId: 1,
              email: 1,
              title: 1,
              price: 1,
              quantity: 1
            }
          }).toArray();
          res.send(result);
        }
      } catch (error) {
        console.error('Error fetching carts:', error);
        res.status(500).send({ error: 'Failed to fetch carts' });
      }
    });

    // Update cart
    app.patch('/carts/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const { quantity } = req.body;

        if (!Number.isInteger(quantity) || quantity < 0) {
          return res.status(400).json({ error: 'Invalid quantity' });
        }

        const result = await CartCollection.updateOne(
          query,
          { $set: { quantity: quantity } }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({ error: 'Item not found' });
        }

        res.status(200).json({ success: true });
      } catch (error) {
        console.error('Error updating cart item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Create cart
    app.post('/carts', async (req, res) => {
      try {
        const cartItem = req.body;
        const result = await CartCollection.insertOne(cartItem);
        
        if (cartItem.email) {
          cache.del(`carts-${cartItem.email}`); // Invalidate user's cart cache
        }
        
        res.send(result);
      } catch (error) {
        console.error('Error creating cart item:', error);
        res.status(500).send({ error: 'Failed to create cart item' });
      }
    });

    // Delete cart
    app.delete('/carts/:id', async (req, res) => {
      try {
        const itemId = req.params.id;
        const query = { _id: new ObjectId(itemId) };
        const result = await CartCollection.deleteOne(query);
        
        res.send(result);
      } catch (error) {
        console.error('Error deleting cart item:', error);
        res.status(500).send({ error: 'Failed to delete cart item' });
      }
    });

  } catch (error) {
    console.error('Database connection error:', error);
  }
}

run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
