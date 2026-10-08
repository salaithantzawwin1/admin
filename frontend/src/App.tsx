import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import { PageLoader } from './components/ui';

// Route-level code splitting: each page lives in its own chunk and is fetched
// on first visit, keeping the main bundle (shell + shared UI components) small.
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Users = lazy(() => import('./pages/Users'));
const Departments = lazy(() => import('./pages/Departments'));
const Employees = lazy(() => import('./pages/Employees'));
const AuditLogs = lazy(() => import('./pages/AuditLogs'));
const Profile = lazy(() => import('./pages/Profile'));
const MyRequests = lazy(() => import('./pages/MyRequests'));
const Approvals = lazy(() => import('./pages/Approvals'));
const RequestDetail = lazy(() => import('./pages/RequestDetail'));
const Delegations = lazy(() => import('./pages/Delegations'));
const Fleet = lazy(() => import('./pages/Fleet'));
const CarRequests = lazy(() => import('./pages/CarRequests'));
const MeetingRooms = lazy(() => import('./pages/MeetingRooms'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Announcements = lazy(() => import('./pages/Announcements'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const Procurement = lazy(() => import('./pages/Procurement'));
const RbacMatrix = lazy(() => import('./pages/RbacMatrix'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    // outer boundary covers /login; Layout's inner boundary keeps the sidebar
    // and chrome stable while an authenticated page chunk loads
    <Suspense fallback={<PageLoader />}>
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
          <Route path="notifications" element={<Notifications />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="procurement" element={<Procurement />} />
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
    </Suspense>
  );
}
