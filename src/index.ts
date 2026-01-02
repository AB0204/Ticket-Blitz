import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod'; // We'll install zod for validation

const app = Fastify({ logger: true });
const prisma = new PrismaClient();

// Connect DB
// -- KAFKA CONFIG --
import { Kafka } from 'kafkajs';

const kafka = new Kafka({
    clientId: 'ticket-blitz-api',
    brokers: ['localhost:9092']
});

const producer = kafka.producer();


// -- ASYNC IMPLEMENTATION (Event Driven) --
// High Performance: We don't write to DB. We just say "Received".
app.post<{ Body: BookingBody }>('/api/book-async', async (request, reply) => {
    const { userId, seatNumber } = request.body;

    // We can still check Redis Cache here for instant feedback (Hybrid approach)
    // But for pure "Event Driven" demo, we just push to queue.

    try {
        await producer.send({
            topic: 'booking-requests',
            messages: [
                { value: JSON.stringify({ userId, seatNumber }) }
            ]
        });

        // 202 Accepted: "We got your request, we'll process it soon."
        return reply.status(202).send({ status: "Pending", message: "Request queued" });

    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Failed to queue request" });
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

// -- REDIS CONFIG --
import Redis from 'ioredis';
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379
});

// Redis Subscriber for Real-time Updates
const subscriber = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379
});

// -- SOCKET.IO CONFIG --
import { Server } from 'socket.io';

// -- SECURE IMPLEMENTATION (Distributed Lock) --
app.post<{ Body: BookingBody }>('/api/book-secure', async (request, reply) => {
    const { userId, seatNumber } = request.body;
    const lockKey = `lock:seat:${seatNumber}`;
    const lockValue = userId;
    const lockTTL = 5; // 5 seconds hold time

    // 1. ACQUIRE LOCK (The Traffic Cop)
    // SET NX: Set if Not Exists. EX: Expire in seconds.
    // Returns "OK" if set, null if already exists.
    // @ts-ignore - ioredis types can be finicky with overloads
    const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', lockTTL);

    if (!acquired) {
        // If we can't get the lock, it means someone else is processing this seat RIGHT NOW.
        // We fail fast to protect the DB.
        return reply.status(429).send({ error: "Seat is currently being booked by someone else. Please try again." });
    }

    try {
        // 2. CRITICAL SECTION (Protected by Lock)

        // Check Status
        const seat = await prisma.seat.findFirst({ where: { number: seatNumber } });
        if (!seat) return reply.status(404).send({ error: "Seat not found" });
        if (seat.status !== "AVAILABLE") return reply.status(409).send({ error: "Seat already taken" });

        const seatId = seat.id;

        // Simulate "Thinking Time" (Auth, Payment Gateway, etc)
        // Even with this delay, no one else can enter because we hold the Redis Lock!
        await new Promise(r => setTimeout(r, 50));

        // Ensure user
        await prisma.user.upsert({
            where: { email: userId },
            update: {},
            create: { id: userId, email: userId, name: "Test User" }
        });

        // Write to DB
        await prisma.seat.update({ where: { id: seatId }, data: { status: "BOOKED" } });
        const booking = await prisma.booking.create({
            data: { userId, seatId }
        });

        return { success: true, bookingId: booking.id };

    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Booking Failed" });
    } finally {
        // 3. RELEASE LOCK
        // Only delete if WE are the owner (Strictly speaking, we should check value, but for demo 'del' is okay)
        // Lua script is safer for production, but this is sufficient for 'Junior/Mid' demo.
        const currentLockValue = await redis.get(lockKey);
        if (currentLockValue === lockValue) {
            await redis.del(lockKey);
        }
    }
});

// Connect Kafka on startup
const start = async () => {
    try {
        await producer.connect();
        console.log("Kafka Producer Connected");

        const port = Number(process.env.PORT) || 3000;

        // We must pass the HTTP server to Socket.io
        const serverAddress = await app.listen({ port, host: '0.0.0.0' });
        console.log(`Server running on ${serverAddress}`);

        // Initialize Socket.io
        const io = new Server(app.server, {
            cors: { origin: "*" } // Allow all for demo
        });

        io.on('connection', (socket) => {
            console.log('Client connected', socket.id);
        });

        // Subscribe to Worker events
        await subscriber.subscribe('seat-updates');
        subscriber.on('message', (channel, message) => {
            if (channel === 'seat-updates') {
                // Broadcast to frontend
                io.emit('seat-update', JSON.parse(message));
            }
        });

    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};


start();
