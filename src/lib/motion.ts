import type { Transition, Variants } from "framer-motion";

export const motionTransition: Transition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] };
export const pageTransition: Variants = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0, transition: motionTransition }, exit: { opacity: 0, y: -4, transition: { duration: 0.14 } } };
export const sectionReveal: Variants = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0, transition: motionTransition } };
export const cardReveal: Variants = { initial: { opacity: 0, y: 7 }, animate: { opacity: 1, y: 0, transition: motionTransition } };
export const staggerContainer: Variants = { initial: {}, animate: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } } };
export const drawerTransition: Variants = { initial: { x: "100%", opacity: 0.7 }, animate: { x: 0, opacity: 1, transition: motionTransition }, exit: { x: "100%", opacity: 0.7, transition: { duration: 0.18 } } };
export const dialogTransition: Variants = { initial: { opacity: 0, scale: 0.97, y: 8 }, animate: { opacity: 1, scale: 1, y: 0, transition: motionTransition }, exit: { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.16 } } };
export const fadeTransition: Variants = { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.18 } }, exit: { opacity: 0, transition: { duration: 0.14 } } };
