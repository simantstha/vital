"use client"

import { useState, useEffect } from "react"
import { motion, AnimatePresence, type Variants } from "framer-motion"
import {
  Sun,
  MessageCircle,
  TrendingUp,
  ListTodo,
  User,
  Flame,
  Activity,
  Heart,
  Moon,
  Dumbbell,
  Utensils,
  Clock,
  ChevronRight,
  Scale,
  FileText,
  Check,
  Send,
  Plus,
} from "lucide-react"

// Colors
const colors = {
  bg: "#0B0F14",
  accent: "#C7F23B",
  alert: "#FF6B6B",
  text: "#F5F2EC",
  muted: "#7A8694",
  glass: "rgba(255,255,255,0.05)",
  glassBorder: "rgba(255,255,255,0.08)",
}

// Tab data
const tabs = [
  { id: "today", label: "Today", icon: Sun },
  { id: "coach", label: "Coach", icon: MessageCircle },
  { id: "trends", label: "Trends", icon: TrendingUp },
  { id: "logs", label: "Logs", icon: ListTodo },
  { id: "profile", label: "Profile", icon: User },
]

// Stagger animation container
const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
    },
  },
}

const staggerItem: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
}

// Recovery Ring Component
function RecoveryRing({ value }: { value: number }) {
  const [animatedValue, setAnimatedValue] = useState(0)
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (animatedValue / 100) * circumference

  useEffect(() => {
    const timer = setTimeout(() => setAnimatedValue(value), 100)
    return () => clearTimeout(timer)
  }, [value])

  return (
    <div className="relative w-[140px] h-[140px]">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={colors.glass}
          strokeWidth="10"
        />
        <motion.circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke={colors.accent}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-3xl font-semibold" style={{ color: colors.text }}>
          {animatedValue}%
        </span>
        <span className="text-xs" style={{ color: colors.muted }}>
          Recovery
        </span>
      </div>
    </div>
  )
}

// Today Screen
function TodayScreen() {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="p-5 space-y-5 overflow-auto h-full pb-24"
    >
      {/* Greeting */}
      <motion.div variants={staggerItem}>
        <h1 className="font-serif text-2xl" style={{ color: colors.text }}>
          Good morning, Simant.
        </h1>
      </motion.div>

      {/* Day chips */}
      <motion.div variants={staggerItem} className="flex gap-2">
        <div
          className="px-3 py-1.5 rounded-full text-xs font-medium"
          style={{ background: colors.glass, color: colors.muted }}
        >
          Sunday, Jan 19
        </div>
        <div
          className="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5"
          style={{ background: "rgba(199, 242, 59, 0.15)", color: colors.accent }}
        >
          <Flame size={12} />
          12-day streak
        </div>
      </motion.div>

      {/* Recovery Ring + Stats */}
      <motion.div
        variants={staggerItem}
        className="rounded-2xl p-5"
        style={{
          background: colors.glass,
          border: `1px solid ${colors.glassBorder}`,
        }}
      >
        <div className="flex items-center gap-5">
          <RecoveryRing value={78} />
          <div className="flex-1 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs flex items-center gap-2" style={{ color: colors.muted }}>
                <Activity size={14} style={{ color: colors.accent }} />
                HRV
              </span>
              <span className="font-mono text-sm" style={{ color: colors.text }}>
                58 ms
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs flex items-center gap-2" style={{ color: colors.muted }}>
                <Heart size={14} style={{ color: colors.alert }} />
                RHR
              </span>
              <span className="font-mono text-sm" style={{ color: colors.text }}>
                52 bpm
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs flex items-center gap-2" style={{ color: colors.muted }}>
                <Moon size={14} style={{ color: "#8B93FF" }} />
                Sleep
              </span>
              <span className="font-mono text-sm" style={{ color: colors.text }}>
                7h 23m
              </span>
            </div>
          </div>
        </div>
        <div
          className="mt-4 pt-4 flex items-center justify-between"
          style={{ borderTop: `1px solid ${colors.glassBorder}` }}
        >
          <span className="text-xs" style={{ color: colors.muted }}>
            Strain
          </span>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 rounded-full overflow-hidden" style={{ background: colors.glass }}>
              <div
                className="h-full rounded-full"
                style={{ width: "35%", background: colors.alert }}
              />
            </div>
            <span className="font-mono text-sm" style={{ color: colors.alert }}>
              5.2
            </span>
          </div>
        </div>
      </motion.div>

      {/* Coach Bubble */}
      <motion.div
        variants={staggerItem}
        className="rounded-2xl p-4"
        style={{
          background: "rgba(199, 242, 59, 0.12)",
          border: `1px solid rgba(199, 242, 59, 0.2)`,
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
            style={{ background: colors.accent }}
          >
            <MessageCircle size={16} style={{ color: colors.bg }} />
          </div>
          <p className="text-sm leading-relaxed" style={{ color: colors.text }}>
            {"Recovery's solid. Push Zone 2 today, 45 min. You're under on protein — aim 180g."}
          </p>
        </div>
      </motion.div>

      {/* Prescription Tiles */}
      <motion.div variants={staggerItem} className="grid grid-cols-2 gap-3">
        <motion.div
          whileTap={{ scale: 0.95 }}
          className="rounded-xl p-4"
          style={{ background: colors.accent }}
        >
          <Dumbbell size={20} style={{ color: colors.bg }} />
          <p className="mt-2 text-sm font-medium" style={{ color: colors.bg }}>
            Zone 2 Run
          </p>
          <p className="text-xs mt-0.5" style={{ color: "rgba(11, 15, 20, 0.6)" }}>
            45 min target
          </p>
        </motion.div>
        <motion.div
          whileTap={{ scale: 0.95 }}
          className="rounded-xl p-4"
          style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
        >
          <Utensils size={20} style={{ color: colors.text }} />
          <p className="mt-2 text-sm font-medium" style={{ color: colors.text }}>
            2,400 kcal
          </p>
          <p className="text-xs mt-0.5" style={{ color: colors.muted }}>
            180g protein
          </p>
        </motion.div>
        <motion.div
          whileTap={{ scale: 0.95 }}
          className="rounded-xl p-4"
          style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
        >
          <Moon size={20} style={{ color: colors.text }} />
          <p className="mt-2 text-sm font-medium" style={{ color: colors.text }}>
            22:30 Lights Out
          </p>
          <p className="text-xs mt-0.5" style={{ color: colors.muted }}>
            8h target
          </p>
        </motion.div>
        <motion.div
          whileTap={{ scale: 0.95 }}
          className="rounded-xl p-4"
          style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
        >
          <Activity size={20} style={{ color: colors.text }} />
          <p className="mt-2 text-sm font-medium" style={{ color: colors.text }}>
            10 min Mobility
          </p>
          <p className="text-xs mt-0.5" style={{ color: colors.muted }}>
            Hip & ankle focus
          </p>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}

// Coach Screen
function CoachScreen() {
  const messages = [
    {
      id: 1,
      sender: "coach",
      text: "Good morning! I noticed your HRV is up 12% this week. Your body is adapting well to the training load.",
    },
    {
      id: 2,
      sender: "user",
      text: "That's great! Should I push harder today?",
    },
    {
      id: 3,
      sender: "coach",
      text: "Your recovery is at 78%, which is solid. I'd recommend a Zone 2 session — 45 minutes at 130-145 bpm. This builds aerobic base without adding too much strain.",
    },
    {
      id: 4,
      sender: "user",
      text: "Got it. What about nutrition?",
    },
    {
      id: 5,
      sender: "coach",
      text: "You've been consistently under on protein. Aim for 180g today — that's about 40g per meal plus a shake. I've updated your MyFitnessPal target.",
    },
  ]

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="flex flex-col h-full"
    >
      {/* Header */}
      <motion.div
        variants={staggerItem}
        className="px-5 py-4 flex items-center gap-3"
        style={{ borderBottom: `1px solid ${colors.glassBorder}` }}
      >
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ background: colors.accent }}
        >
          <MessageCircle size={20} style={{ color: colors.bg }} />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium" style={{ color: colors.text }}>
            Coach
          </p>
          <p className="text-xs flex items-center gap-1.5" style={{ color: colors.muted }}>
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: colors.accent }}
            />
            Synced with Telegram
          </p>
        </div>
      </motion.div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-5 space-y-4 pb-20">
        {messages.map((msg, index) => (
          <motion.div
            key={msg.id}
            variants={staggerItem}
            custom={index}
            className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
          >
            <motion.div
              whileTap={{ scale: 0.95 }}
              className="max-w-[80%] rounded-2xl px-4 py-3"
              style={{
                background: msg.sender === "user" ? colors.accent : colors.glass,
                borderBottomRightRadius: msg.sender === "user" ? 4 : 16,
                borderBottomLeftRadius: msg.sender === "coach" ? 4 : 16,
              }}
            >
              <p
                className="text-sm leading-relaxed"
                style={{ color: msg.sender === "user" ? colors.bg : colors.text }}
              >
                {msg.text}
              </p>
            </motion.div>
          </motion.div>
        ))}

        {/* Typing indicator */}
        <motion.div variants={staggerItem} className="flex justify-start">
          <div
            className="rounded-2xl px-4 py-3 flex items-center gap-1"
            style={{ background: colors.glass }}
          >
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="w-2 h-2 rounded-full"
                style={{ background: colors.muted }}
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{
                  duration: 1.2,
                  repeat: Infinity,
                  delay: i * 0.2,
                }}
              />
            ))}
          </div>
        </motion.div>
      </div>

      {/* Input */}
      <div
        className="absolute bottom-16 left-0 right-0 p-4"
        style={{ background: colors.bg }}
      >
        <div
          className="flex items-center gap-3 rounded-full px-4 py-3"
          style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
        >
          <Plus size={20} style={{ color: colors.muted }} />
          <span className="flex-1 text-sm" style={{ color: colors.muted }}>
            Message Coach...
          </span>
          <Send size={20} style={{ color: colors.accent }} />
        </div>
      </div>
    </motion.div>
  )
}

// Trends Screen
function TrendsScreen() {
  const [period, setPeriod] = useState<"7d" | "30d" | "90d">("30d")
  const periods = ["7d", "30d", "90d"] as const

  // Sample HRV data points
  const hrvData = [42, 45, 48, 44, 52, 55, 50, 58, 54, 60, 56, 58]

  const maxHrv = Math.max(...hrvData)
  const minHrv = Math.min(...hrvData)
  const range = maxHrv - minHrv

  // Create SVG path
  const width = 300
  const height = 100
  const points = hrvData.map((val, i) => {
    const x = (i / (hrvData.length - 1)) * width
    const y = height - ((val - minHrv) / range) * height
    return `${x},${y}`
  })
  const linePath = `M ${points.join(" L ")}`
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`

  const stats = [
    { label: "Avg Sleep", value: "7h 12m", delta: "+23m", positive: true },
    { label: "Weight", value: "172 lbs", delta: "-2.3", positive: true },
    { label: "Strain", value: "12.4", delta: "+1.2", positive: false },
    { label: "Workouts", value: "18", delta: "+3", positive: true },
  ]

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="p-5 space-y-5 overflow-auto h-full pb-24"
    >
      {/* Header */}
      <motion.div variants={staggerItem}>
        <h1 className="font-serif text-2xl" style={{ color: colors.text }}>
          Trends
        </h1>
      </motion.div>

      {/* Period Selector */}
      <motion.div
        variants={staggerItem}
        className="relative flex rounded-full p-1"
        style={{ background: colors.glass }}
      >
        {periods.map((p) => (
          <motion.button
            key={p}
            onClick={() => setPeriod(p)}
            className="relative flex-1 py-2 text-sm font-medium z-10"
            style={{ color: period === p ? colors.bg : colors.muted }}
            whileTap={{ scale: 0.95 }}
          >
            {period === p && (
              <motion.div
                layoutId="period-pill"
                className="absolute inset-0 rounded-full"
                style={{ background: colors.accent }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative z-10">{p}</span>
          </motion.button>
        ))}
      </motion.div>

      {/* HRV Chart */}
      <motion.div
        variants={staggerItem}
        className="rounded-2xl p-5"
        style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm" style={{ color: colors.muted }}>
            HRV Trend
          </span>
          <span className="font-mono text-lg" style={{ color: colors.accent }}>
            58 ms
          </span>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-24">
          <defs>
            <linearGradient id="hrvGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={colors.accent} stopOpacity="0.3" />
              <stop offset="100%" stopColor={colors.accent} stopOpacity="0" />
            </linearGradient>
          </defs>
          <motion.path
            d={areaPath}
            fill="url(#hrvGradient)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          />
          <motion.path
            d={linePath}
            fill="none"
            stroke={colors.accent}
            strokeWidth="2"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.5, ease: "easeOut" }}
          />
        </svg>
      </motion.div>

      {/* Stats Grid */}
      <motion.div variants={staggerItem} className="grid grid-cols-2 gap-3">
        {stats.map((stat) => (
          <motion.div
            key={stat.label}
            whileTap={{ scale: 0.95 }}
            className="rounded-xl p-4"
            style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
          >
            <p className="text-xs" style={{ color: colors.muted }}>
              {stat.label}
            </p>
            <p className="font-mono text-xl mt-1" style={{ color: colors.text }}>
              {stat.value}
            </p>
            <p
              className="text-xs mt-1 flex items-center gap-1"
              style={{ color: stat.positive ? colors.accent : colors.alert }}
            >
              <span>{stat.positive ? "↑" : "↓"}</span>
              {stat.delta}
            </p>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  )
}

// Logs Screen
function LogsScreen() {
  const logs = [
    {
      id: 1,
      time: "07:15",
      icon: Dumbbell,
      iconBg: colors.accent,
      title: "Morning Run",
      detail: "5.2 mi • Zone 2 • 45:23",
    },
    {
      id: 2,
      time: "08:30",
      icon: Utensils,
      iconBg: "#8B93FF",
      title: "Breakfast",
      detail: "620 kcal • 42g protein",
    },
    {
      id: 3,
      time: "12:45",
      icon: Utensils,
      iconBg: "#8B93FF",
      title: "Lunch",
      detail: "780 kcal • 52g protein",
    },
    {
      id: 4,
      time: "15:00",
      icon: Scale,
      iconBg: colors.muted,
      title: "Weight Check",
      detail: "172.4 lbs • -0.6 from yesterday",
    },
    {
      id: 5,
      time: "18:30",
      icon: Utensils,
      iconBg: "#8B93FF",
      title: "Dinner",
      detail: "850 kcal • 58g protein",
    },
    {
      id: 6,
      time: "19:00",
      icon: FileText,
      iconBg: colors.alert,
      title: "Lab Results",
      detail: "Vitamin D: 45 ng/mL • Optimal",
    },
  ]

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="p-5 space-y-5 overflow-auto h-full pb-24"
    >
      {/* Header */}
      <motion.div variants={staggerItem}>
        <h1 className="font-serif text-2xl" style={{ color: colors.text }}>
          {"Today's Log"}
        </h1>
        <p className="text-sm mt-1" style={{ color: colors.muted }}>
          Sunday, January 19
        </p>
      </motion.div>

      {/* Timeline */}
      <div className="space-y-2">
        {logs.map((log, index) => (
          <motion.div
            key={log.id}
            variants={staggerItem}
            custom={index}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-4 rounded-xl p-3"
            style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
          >
            <span className="font-mono text-xs w-10" style={{ color: colors.muted }}>
              {log.time}
            </span>
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: log.iconBg }}
            >
              <log.icon size={18} style={{ color: colors.bg }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: colors.text }}>
                {log.title}
              </p>
              <p className="text-xs truncate" style={{ color: colors.muted }}>
                {log.detail}
              </p>
            </div>
            <ChevronRight size={16} style={{ color: colors.muted }} />
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

// Profile Screen
function ProfileScreen() {
  const stats = [
    { label: "Green Days", value: "127" },
    { label: "Workouts", value: "89" },
    { label: "Avg HRV", value: "54" },
  ]

  const integrations = [
    { name: "Whoop", synced: true },
    { name: "Strava", synced: true },
    { name: "MyFitnessPal", synced: true },
    { name: "Telegram", synced: true },
    { name: "Apple Health", synced: false },
  ]

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="p-5 space-y-6 overflow-auto h-full pb-24"
    >
      {/* Avatar & Name */}
      <motion.div variants={staggerItem} className="flex flex-col items-center text-center">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center"
          style={{ background: colors.accent }}
        >
          <span className="font-serif text-3xl" style={{ color: colors.bg }}>
            S
          </span>
        </div>
        <h1 className="font-serif text-2xl mt-4" style={{ color: colors.text }}>
          Simant Shrestha
        </h1>
        <p className="text-sm" style={{ color: colors.muted }}>
          Member since October 2024
        </p>
      </motion.div>

      {/* Stats */}
      <motion.div variants={staggerItem} className="flex justify-around">
        {stats.map((stat) => (
          <div key={stat.label} className="text-center">
            <p className="font-mono text-2xl" style={{ color: colors.accent }}>
              {stat.value}
            </p>
            <p className="text-xs mt-1" style={{ color: colors.muted }}>
              {stat.label}
            </p>
          </div>
        ))}
      </motion.div>

      {/* Integrations */}
      <motion.div variants={staggerItem}>
        <h2 className="text-sm font-medium mb-3" style={{ color: colors.text }}>
          Integrations
        </h2>
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: colors.glass, border: `1px solid ${colors.glassBorder}` }}
        >
          {integrations.map((integration, index) => (
            <motion.div
              key={integration.name}
              whileTap={{ scale: 0.98 }}
              className="flex items-center justify-between px-4 py-3"
              style={{
                borderTop: index > 0 ? `1px solid ${colors.glassBorder}` : undefined,
              }}
            >
              <span className="text-sm" style={{ color: colors.text }}>
                {integration.name}
              </span>
              {integration.synced ? (
                <div className="flex items-center gap-2">
                  <Check size={14} style={{ color: colors.accent }} />
                  <span className="text-xs" style={{ color: colors.accent }}>
                    Synced
                  </span>
                </div>
              ) : (
                <button
                  className="px-3 py-1 rounded-full text-xs font-medium"
                  style={{ background: colors.glass, color: colors.text }}
                >
                  Connect
                </button>
              )}
            </motion.div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}

// Main Component
export default function VitalMockup() {
  const [activeTab, setActiveTab] = useState("today")

  const renderScreen = () => {
    switch (activeTab) {
      case "today":
        return <TodayScreen />
      case "coach":
        return <CoachScreen />
      case "trends":
        return <TrendsScreen />
      case "logs":
        return <LogsScreen />
      case "profile":
        return <ProfileScreen />
      default:
        return <TodayScreen />
    }
  }

  return (
    <>
      <style>{`html, body { overflow: auto !important; height: auto !important; }`}</style>
    <div
      className="min-h-screen flex items-start md:items-center justify-center p-4 md:p-8"
      style={{ background: colors.bg }}
    >
      {/* iPhone 15 Pro Frame */}
      <div
        className="relative w-[390px] h-[844px] rounded-[54px] overflow-hidden"
        style={{
          background: colors.bg,
          boxShadow: `
            0 0 0 1px rgba(255,255,255,0.1),
            0 25px 50px -12px rgba(0,0,0,0.5),
            0 0 0 14px #1a1a1a,
            0 0 0 16px #2a2a2a
          `,
        }}
      >
        {/* Dynamic Island */}
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 w-[126px] h-[37px] rounded-full z-50"
          style={{ background: "#000" }}
        />

        {/* Status Bar */}
        <div
          className="absolute top-0 left-0 right-0 h-12 flex items-end justify-between px-8 pb-1 z-40"
          style={{ background: colors.bg }}
        >
          <span className="font-mono text-xs" style={{ color: colors.text }}>
            9:41
          </span>
          <div className="flex items-center gap-1">
            <div
              className="w-4 h-2 rounded-sm"
              style={{ border: `1px solid ${colors.text}` }}
            >
              <div
                className="w-2.5 h-1 rounded-sm m-px"
                style={{ background: colors.accent }}
              />
            </div>
          </div>
        </div>

        {/* Screen Content */}
        <div className="absolute top-12 bottom-0 left-0 right-0 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              {renderScreen()}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Tab Bar */}
        <div
          className="absolute bottom-0 left-0 right-0 h-20 flex items-start justify-around pt-2 px-4"
          style={{
            background: `linear-gradient(to top, ${colors.bg} 70%, transparent)`,
          }}
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <motion.button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex flex-col items-center gap-1 w-16 py-2"
                whileTap={{ scale: 0.9 }}
              >
                {isActive && (
                  <motion.div
                    layoutId="tab-pill"
                    className="absolute inset-0 rounded-xl"
                    style={{ background: "rgba(199, 242, 59, 0.15)" }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
                <tab.icon
                  size={22}
                  style={{ color: isActive ? colors.accent : colors.muted }}
                  className="relative z-10"
                />
                <span
                  className="text-[10px] relative z-10"
                  style={{ color: isActive ? colors.accent : colors.muted }}
                >
                  {tab.label}
                </span>
              </motion.button>
            )
          })}
        </div>

        {/* Home Indicator */}
        <div
          className="absolute bottom-2 left-1/2 -translate-x-1/2 w-32 h-1 rounded-full"
          style={{ background: colors.text, opacity: 0.3 }}
        />
      </div>
    </div>
    </>
  )
}
