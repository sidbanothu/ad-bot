"use client";
import { ReactNode } from "react";
import { ApolloProvider } from "@apollo/client";
import client from "../lib/apollo-client";
import { WhopThemeProvider } from "@whop-apps/sdk";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ApolloProvider client={client}>
      <WhopThemeProvider>{children}</WhopThemeProvider>
    </ApolloProvider>
  );
} 