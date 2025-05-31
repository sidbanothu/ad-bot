import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';

const httpLink = new HttpLink({
  uri: process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT || 'YOUR_GRAPHQL_ENDPOINT_HERE',
  // Add any additional headers if needed
  headers: {
    // Add your authentication headers here if required
    // 'Authorization': `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}`,
  },
});

const client = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache(),
  defaultOptions: {
    watchQuery: {
      fetchPolicy: 'cache-and-network',
    },
  },
});

export default client; 