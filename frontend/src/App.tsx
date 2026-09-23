import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Departments from './pages/Departments';
import Employees from './pages/Employees';
import AuditLogs from './pages/AuditLogs';
import Profile from './pages/Profile';
import MyRequests from './pages/MyRequests';
import Approvals from './pages/Approvals';
import RequestDetail from './pages/RequestDetail';
import Delegations from './pages/Delegations';
import Fleet from './pages/Fleet';
import CarRequests from './pages/CarRequests';
import MeetingRooms from './pages/MeetingRooms';
import Inventory from './pages/Inventory';
import Announcements from './pages/Announcements';
import Suppliers from './pages/Suppliers';
import RbacMatrix from './pages/RbacMatrix';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="requests" element={<MyRequests />} />
        <Route path="requests/:id" element={<RequestDetail />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="delegations" element={<Delegations />} />
        <Route path="fleet" element={<Fleet />} />
        <Route path="car-requests" element={<CarRequests />} />
        <Route path="meeting-rooms" element={<MeetingRooms />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="announcements" element={<Announcements />} />
        <Route path="suppliers" element={<Suppliers />} />
        <Route path="users" element={<Users />} />
        <Route path="departments" element={<Departments />} />
        <Route path="employees" element={<Employees />} />
        <Route path="audit-logs" element={<AuditLogs />} />
        <Route path="rbac" element={<RbacMatrix />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
