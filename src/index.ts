import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });
const prisma = new PrismaClient();

// Enable CORS
app.register(cors, {
    origin: ["http://localhost:5173", "https://ticket-blitz.vercel.app"], // Production Vercel domain
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

// Health Check Endpoint (for Render/Railway)
app.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

// -- KAFKA CONFIG (Disabled for Quick Demo Mode) --
// import { Kafka } from 'kafkajs';
// const kafka = new Kafka({
//     clientId: 'ticket-blitz-api',
//     brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
// });
// const producer = kafka.producer();


// -- SIMPLIFIED ASYNC IMPLEMENTATION (Direct DB Write) --
// Quick Demo Mode: Direct database write without Kafka queue
app.post<{ Body: BookingBody }>('/api/book-async', async (request, reply) => {
    const { userId, seatNumber } = request.body;

    try {
        // Find the seat
        const seat = await prisma.seat.findFirst({
            where: { number: seatNumber }
        });

        if (!seat) {
            return reply.status(404).send({ error: "Seat not found" });
        }

        if (seat.status !== "AVAILABLE") {
            return reply.status(409).send({ error: "Seat already taken" });
        }

        const seatId = seat.id;

        // Ensure user exists
        await prisma.user.upsert({
            where: { email: userId },
            update: {},
            create: {
                id: userId,
                email: userId,
                name: "Test User"
            }
        });

        // Book the seat (atomic update)
        await prisma.seat.update({
            where: { id: seatId },
            data: { status: "BOOKED" }
        });

        const booking = await prisma.booking.create({
            data: {
                userId: userId,
                seatId: seatId
            }
        });

        // Return success immediately
        return reply.status(200).send({
            success: true,
            bookingId: booking.id,
            status: "Booked"
        });

    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Failed to process booking" });
    }
});

// -- NAIVE IMPLEMENTATION (Vulnerable to Race Conditions) --
// SCENARIO: 2 concurrent requests check status "AVAILABLE" at same time.
// Both pass the 'if' check. Both execute update. Result: Double Booking.

interface BookingBody {
    userId: string;
    seatNumber: number;
}

app.post<{ Body: BookingBody }>('/api/book-naive', async (request, reply) => {
    const { userId, seatNumber } = request.body;

    // 1. READ: Check if seat is available
    // We assume eventId is fixed for this demo (the one we seeded)
    // Ideally we pass eventId, but valid simplification for locking demo.
    const seat = await prisma.seat.findFirst({
        where: { number: seatNumber }
    });

    if (!seat) {
        return reply.status(404).send({ error: "Seat not found" });
    }

    const seatId = seat.id;

    if (seat.status !== "AVAILABLE") {
        // In high concurrency, 100 requests might SKIP this check because
        // they all read the DB state before the first one finished writing.
        return reply.status(409).send({ error: "Seat already taken" });
    }

    // 2. SIMULATE LATENCY (The "Thinking Time")
    // This gap is where the race condition happens.
    await new Promise(r => setTimeout(r, 50));

    // Ensure user exists (Mock Auth)
    // We use the passed userId as both ID and Email for simplicity
    await prisma.user.upsert({
        where: { email: userId },
        update: {},
        create: {
            id: userId,
            email: userId,
            name: "Test User"
        }
    });

    // 3. WRITE: Book the seat
    // We explicitly do NOT use a transaction here to demonstrate the flaw.
    await prisma.seat.update({
        where: { id: seatId },
        data: { status: "BOOKED" }
    });

    const booking = await prisma.booking.create({
        data: {
            userId: userId,
            seatId: seatId
        }
    });

    return { success: true, bookingId: booking.id };
});

// Helper to get a random available seat (for testing)
app.get('/api/random-seat', async (req, reply) => {
    const seat = await prisma.seat.findFirst({
        where: { status: "AVAILABLE" }
    });
    return seat;
});

// -- REDIS CONFIG (Disabled for Quick Demo Mode) --
// import Redis from 'ioredis';
// const redis = new Redis({
//     host: process.env.REDIS_HOST || 'localhost',
//     port: Number(process.env.REDIS_PORT) || 6379
// });
// const subscriber = new Redis({
//     host: process.env.REDIS_HOST || 'localhost',
//     port: Number(process.env.REDIS_PORT) || 6379
// });

// -- SOCKET.IO CONFIG --
import { Server } from 'socket.io';

// -- SECURE IMPLEMENTATION (Distributed Lock) - Disabled for Quick Demo Mode --
// app.post<{ Body: BookingBody }>('/api/book-secure', async (request, reply) => {
//     const { userId, seatNumber } = request.body;
//     const lockKey = `lock:seat:${seatNumber}`;
//     const lockValue = userId;
//     const lockTTL = 5;
//     const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', lockTTL);
//     if (!acquired) {
//         return reply.status(429).send({ error: "Seat is currently being booked by someone else. Please try again." });
//     }
//     try {
//         const seat = await prisma.seat.findFirst({ where: { number: seatNumber } });
//         if (!seat) return reply.status(404).send({ error: "Seat not found" });
//         if (seat.status !== "AVAILABLE") return reply.status(409).send({ error: "Seat already taken" });
//         const seatId = seat.id;
//         await new Promise(r => setTimeout(r, 50));
//         await prisma.user.upsert({
//             where: { email: userId },
//             update: {},
//             create: { id: userId, email: userId, name: "Test User" }
//         });
//         await prisma.seat.update({ where: { id: seatId }, data: { status: "BOOKED" } });
//         const booking = await prisma.booking.create({
//             data: { userId, seatId }
//         });
//         return { success: true, bookingId: booking.id };
//     } catch (error) {
//         app.log.error(error);
//         return reply.status(500).send({ error: "Booking Failed" });
//     } finally {
//         const unlockScript = `
//             if redis.call("get", KEYS[1]) == ARGV[1] then
//                 return redis.call("del", KEYS[1])
//             else
//                 return 0
//             end
//         `;
//         await redis.eval(unlockScript, 1, lockKey, lockValue);
//     }
// });

// -- QUICK DEMO MODE STARTUP (No External Dependencies) --
// import { runWorker } from './worker'; // Disabled for quick demo mode

const start = async () => {
    try {
        const port = Number(process.env.PORT) || 3000;

        // Start the HTTP server FIRST (critical for health checks)
        const serverAddress = await app.listen({ port, host: '0.0.0.0' });
        console.log(`✅ Server running on ${serverAddress}`);
        console.log(`🎯 Quick Demo Mode: Kafka and Redis disabled`);

        // Initialize Socket.io for real-time updates
        const io = new Server(app.server, {
            cors: { origin: "*" } // Allow all for demo
        });

        io.on('connection', (socket) => {
            console.log('Client connected', socket.id);
        });

        // No Kafka or Redis connections needed in quick demo mode

    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};


start();
