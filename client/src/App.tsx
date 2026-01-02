import { useEffect, useState } from 'react';
import io from 'socket.io-client';
import './App.css';

// Connect to API Server (localhost for development)
const socket = io('http://localhost:3000');

type SeatStatus = 'AVAILABLE' | 'BOOKED' | 'LOCKED' | 'PENDING';

interface Seat {
  id: number;
  status: SeatStatus;
}

function App() {
  const [seats, setSeats] = useState<Seat[]>(
    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: 'AVAILABLE' }))
  );

  // Track "optimistic" booking attempts to show spinner/yellow state
  const [pendingSeats, setPendingSeats] = useState<Set<number>>(new Set());

  const [metrics, setMetrics] = useState({ booked: 0, available: 100 });

  useEffect(() => {
    // Listen for updates
    socket.on('seat-update', (data: { seatNumber: number; status: SeatStatus }) => {
      // console.log("Update received:", data);
      setSeats(prev => prev.map(seat => {
        if (seat.id === data.seatNumber) {
          // Remove from pending if it was pending
          if (pendingSeats.has(seat.id)) {
            const newPending = new Set(pendingSeats);
            newPending.delete(seat.id);
            setPendingSeats(newPending);
          }
          return { ...seat, status: data.status };
        }
        return seat;
      }));
    });

    return () => {
      socket.off('seat-update');
    };
  }, [pendingSeats]);

  useEffect(() => {
    const bookedCount = seats.filter(s => s.status === 'BOOKED').length;
    setMetrics({
      booked: bookedCount,
      available: 100 - bookedCount
    });
  }, [seats]);

  const handleSeatClick = async (seat: Seat) => {
    if (seat.status !== 'AVAILABLE') return;

    // 1. Optimistic UI Update (Yellow/Pending)
    setPendingSeats(prev => new Set(prev).add(seat.id));
    setSeats(prev => prev.map(s =>
      s.id === seat.id ? { ...s, status: 'PENDING' } : s
    ));

    try {
      // 2. Fire and Forget (Async Architecture)
      // We don't wait for the booking confirmation here. 
      // We wait for the Websocket event to turn it Red.
      await fetch('http://localhost:3000/api/book-async', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: `demo_user_${Math.floor(Math.random() * 1000)}`,
          seatNumber: seat.id
        })
      });

    } catch (err) {
      console.error("Booking request failed", err);
      // Revert on failure (optional for this simple demo)
      setSeats(prev => prev.map(s =>
        s.id === seat.id ? { ...s, status: 'AVAILABLE' } : s
      ));
    }
  };

  return (
    <div className="container">
      <h1>TicketBlitz Live ⚡</h1>

      <div className="metrics">
        <div className="card">
          <h3>Available</h3>
          <span className="green">{metrics.available}</span>
        </div>
        <div className="card">
          <h3>Sold Out</h3>
          <span className="red">{metrics.booked}</span>
        </div>
      </div>

      <div className="grid">
        {seats.map(seat => (
          <div
            key={seat.id}
            onClick={() => handleSeatClick(seat)}
            className={`seat ${seat.status.toLowerCase()}`}
            title={`Seat ${seat.id}`}
          >
            {seat.status === 'PENDING' ? '...' : seat.id}
          </div>
        ))}
      </div>

      <p style={{ marginTop: '2rem', color: '#666', fontSize: '0.8rem' }}>
        Backend: Node.js + Fastify + Redis + Kafka | Frontend: React + Socket.io
      </p>
    </div>
  );
}

export default App;
